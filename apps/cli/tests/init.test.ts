import { describe, expect, test } from "vite-plus/test";
import { loadRegistry, readSecretspec } from "@keypin/core";
import { cli } from "../src/cli";
import { destinations, issuers, vaults } from "../src/start";
import { template } from "../src/commands/init";
import { ESC, fakeDeps, REGISTRY } from "./fakes";
import { changes, recording } from "./recording";

const TEMPLATE = template("billing");

async function record(name: string, args: string[], run: ReturnType<typeof fakeDeps>) {
  const before = new Map(run.disk.contents);
  const exit = await cli(args, run.deps);
  const shown = (text: string) => text.replaceAll(ESC, "\\e");
  await expect(
    recording({
      args,
      exit,
      stdout: shown(run.stdout.text),
      stderr: shown(run.stderr.text),
      files: Object.fromEntries(before),
      given: { cwd: run.deps.cwd, home: run.deps.home, styled: run.deps.styled },
      wrote: changes(before, run.disk.contents),
    }),
  ).toMatchFileSnapshot(`./recordings/init/${name}.txt`);
  return exit;
}

describe("keypin init", () => {
  test("registers the current folder, writes the template, and points at check", async () => {
    const run = fakeDeps();
    const { disk } = run;
    expect(await record("current-folder", ["init"], run)).toBe(0);
    expect(disk.contents.get("/work/billing/secretspec.toml")).toBe(TEMPLATE);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual(["/work/billing"]);
  });

  test("in a terminal, marks each line with a check and shortens the home folder", async () => {
    const run = fakeDeps({
      deps: { cwd: "/home/me/code/shop", styled: { stdout: true, stderr: true } },
    });
    run.disk.folders.add("/home/me/code/shop");
    expect(await record("terminal", ["init"], run)).toBe(0);
    expect(run.stderr.text).not.toContain("keypin:");
  });

  test("quotes a folder with a space in the check command it suggests", async () => {
    const { deps, disk, stderr } = fakeDeps();
    disk.folders.add("/work/my project");
    expect(await cli(["init", "/work/my project"], deps)).toBe(0);
    expect(stderr.text).toContain("\nNext: keypin check '/work/my project'  what this");
  });

  test("the file names the project after its folder and reads as the default and production profiles", () => {
    expect(readSecretspec(TEMPLATE, "secretspec.toml", destinations, issuers, vaults)).toEqual({
      ok: true,
      map: {
        file: "secretspec.toml",
        project: "billing",
        environments: ["default", "production"],
        ignore: [],
        keys: [],
      },
    });
  });

  test("counts one project in the singular, more in the plural", async () => {
    const { deps, stderr } = fakeDeps();
    await cli(["init"], deps);
    expect(stderr.text).toContain("registered (1 project)\n");
    await cli(["init", "/work/web"], deps);
    expect(stderr.text).toContain("registered (2 projects)\n");
  });

  test("registers a folder given as an argument, relative to the current folder", async () => {
    const { deps, disk } = fakeDeps({ deps: { cwd: "/work" } });
    expect(await cli(["init", "web"], deps)).toBe(0);
    expect(disk.contents.has("/work/web/secretspec.toml")).toBe(true);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual(["/work/web"]);
  });

  test("refuses a secretspec.toml that is a symbolic link, and registers nothing", async () => {
    const { deps, disk, stderr } = fakeDeps();
    disk.links.add("/work/billing/secretspec.toml");
    expect(await cli(["init"], deps)).toBe(1);
    expect(stderr.text).toContain("/work/billing/secretspec.toml is a symbolic link");
    expect(disk.contents.size).toBe(0);
  });

  test("never overwrites an existing secretspec.toml", async () => {
    const { deps, disk, stderr } = fakeDeps();
    disk.contents.set("/work/billing/secretspec.toml", "# mine\n");
    expect(await cli(["init"], deps)).toBe(0);
    expect(disk.contents.get("/work/billing/secretspec.toml")).toBe("# mine\n");
    expect(stderr.text).toContain(
      "ok     /work/billing/secretspec.toml exists; left it as it is\n",
    );
    expect(stderr.text).not.toContain("FAILED");
  });

  test("running it twice is harmless", async () => {
    const { deps, disk } = fakeDeps();
    await cli(["init"], deps);
    const registry = disk.contents.get(REGISTRY);
    expect(await cli(["init"], deps)).toBe(0);
    expect(disk.contents.get(REGISTRY)).toBe(registry);
    expect(disk.contents.get("/work/billing/secretspec.toml")).toBe(TEMPLATE);
  });

  test("uses XDG_CONFIG_HOME when it is absolute", async () => {
    const { deps, disk } = fakeDeps({ deps: { env: { XDG_CONFIG_HOME: "/xdg/config" } } });
    await cli(["init"], deps);
    expect(disk.contents.has("/xdg/config/keypin/registry.json")).toBe(true);
    expect(disk.contents.has(REGISTRY)).toBe(false);
  });

  test("refuses a missing folder and two arguments", async () => {
    const { deps, disk } = fakeDeps();
    expect(await cli(["init", "/nowhere"], deps)).toBe(1);
    expect(await cli(["init", "a", "b"], deps)).toBe(2);
    expect(disk.contents.size).toBe(0);
  });

  test("an inherited property name is an unknown command", async () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const { deps, stderr, disk } = fakeDeps();
      expect(await cli([name], deps)).toBe(2);
      expect(stderr.text).toContain(`unknown command "${name}"`);
      expect(disk.contents.size).toBe(0);
    }
  });
});

describe("keypin init at the same time", () => {
  test("two projects registering at once both stay registered", async () => {
    const first = fakeDeps();
    const second = fakeDeps({ disk: first.disk, deps: { cwd: "/work/web" } });
    const codes = await Promise.all([cli(["init"], first.deps), cli(["init"], second.deps)]);
    expect(codes).toEqual([0, 0]);
    expect((await loadRegistry(first.disk.files, REGISTRY)).projects).toEqual([
      "/work/billing",
      "/work/web",
    ]);
    expect(first.disk.contents.has(`${REGISTRY}.lock`)).toBe(false);
  });
});

describe("keypin init while another keypin holds the registry", () => {
  test("waits, then says which process holds it, and writes nothing", async () => {
    const { deps, disk, stderr } = fakeDeps();
    disk.contents.set(`${REGISTRY}.lock`, "4242\n");
    expect(await cli(["init"], deps)).toBe(1);
    expect(stderr.text).toContain(
      `keypin init: another keypin (process 4242) holds ${REGISTRY}.lock and is still running. Wait for it to finish.`,
    );
    expect(disk.contents.has(REGISTRY)).toBe(false);
  }, 10_000);
});
