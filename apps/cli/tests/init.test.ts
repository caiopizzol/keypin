import { assert, describe, expect, test } from "vite-plus/test";
import { loadRegistry, parseMap } from "@keypin/core";
import { cli } from "../src/cli";
import { TEMPLATE } from "../src/commands/init";
import { fakeDeps, REGISTRY } from "./fakes";

const VAULT = {
  kind: "1password",
  account: "my.1password.com",
  vault: "Private",
  section: null,
  field: "password",
};
const CLOUDFLARE_ACCOUNT = "11111111111111111111111111111111";

function uncomment(template: string): string {
  return template
    .split("\n")
    .filter((line) => !/^#( [A-Z]| keypin\.toml|$)/.test(line))
    .map((line) => line.replace(/^# ?/, ""))
    .join("\n");
}

describe("keypin init", () => {
  test("registers the current folder, writes the template, and points at check", async () => {
    const { deps, disk, stderr } = fakeDeps();
    expect(await cli(["init"], deps)).toBe(0);
    expect(stderr.text).toContain(
      "keypin: next, run keypin check for what this project uses and the TOML to add\n",
    );
    expect(disk.contents.get("/work/billing/keypin.toml")).toBe(TEMPLATE);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual(["/work/billing"]);
  });

  test("the template is comments only and parses as an empty map", () => {
    expect(TEMPLATE.split("\n").every((line) => line === "" || line.startsWith("#"))).toBe(true);
    expect(parseMap(TEMPLATE, "keypin.toml")).toEqual({
      ok: true,
      map: { file: "keypin.toml", account: null, environments: ["dev", "prod"], keys: [] },
    });
  });

  test("the uncommented example rejects its Cloudflare placeholder until it's filled in", () => {
    expect(parseMap(uncomment(TEMPLATE), "keypin.toml")).toEqual({
      ok: false,
      errors: [
        `keypin.toml: key "EXAMPLE_API_KEY" prod: publish[0]: field "account" is a <...> placeholder: replace it with the Cloudflare account ID the Worker belongs to (32 hex characters; wrangler whoami lists it)`,
      ],
    });
  });

  test("the uncommented example parses, with dev, prod and both destinations", () => {
    const filled = uncomment(TEMPLATE).replace("<cloudflare account ID>", CLOUDFLARE_ACCOUNT);
    const parsed = parseMap(filled, "keypin.toml");
    assert(parsed.ok, JSON.stringify(parsed));
    expect(parsed.map.keys).toEqual([
      {
        name: "EXAMPLE_API_KEY",
        rotateEvery: "180d",
        environments: {
          dev: {
            ref: {
              ...VAULT,
              item: "my-project dev example api key",
              section: null,
              field: "password",
            },
            publish: [],
          },
          prod: {
            ref: {
              ...VAULT,
              item: "my-project prod example api key",
              section: null,
              field: "password",
            },
            publish: [
              {
                to: "cloudflare-worker",
                account: CLOUDFLARE_ACCOUNT,
                worker: "my-worker",
              },
              { to: "github-actions", repo: "owner/repo", account: "owner" },
            ],
          },
        },
      },
    ]);
  });

  test("the template keeps every table header on one line", () => {
    const example = uncomment(TEMPLATE).split("\n");
    expect(example.filter((line) => /[[{]\s*$/.test(line))).toEqual([]);
    expect(
      example.filter((line) => line.startsWith("[[keys.EXAMPLE_API_KEY.prod.publish]]")),
    ).toHaveLength(2);
  });

  test("counts one project in the singular, more in the plural", async () => {
    const { deps, stderr } = fakeDeps();
    await cli(["init"], deps);
    expect(stderr.text).toContain(`/work/billing is registered (1 project in ${REGISTRY})`);
    await cli(["init", "/work/web"], deps);
    expect(stderr.text).toContain(`/work/web is registered (2 projects in ${REGISTRY})`);
  });

  test("registers a folder given as an argument, relative to the current folder", async () => {
    const { deps, disk } = fakeDeps({ deps: { cwd: "/work" } });
    expect(await cli(["init", "web"], deps)).toBe(0);
    expect(disk.contents.has("/work/web/keypin.toml")).toBe(true);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual(["/work/web"]);
  });

  test("refuses a keypin.toml that is a symbolic link, and registers nothing", async () => {
    const { deps, disk, stderr } = fakeDeps();
    disk.links.add("/work/billing/keypin.toml");
    expect(await cli(["init"], deps)).toBe(1);
    expect(stderr.text).toContain("/work/billing/keypin.toml is a symbolic link");
    expect(disk.contents.size).toBe(0);
  });

  test("never overwrites an existing keypin.toml", async () => {
    const { deps, disk, stderr } = fakeDeps();
    disk.contents.set("/work/billing/keypin.toml", "# mine\n");
    expect(await cli(["init"], deps)).toBe(0);
    expect(disk.contents.get("/work/billing/keypin.toml")).toBe("# mine\n");
    expect(stderr.text).toContain("exists; left it as it is");
  });

  test("running it twice is harmless", async () => {
    const { deps, disk } = fakeDeps();
    await cli(["init"], deps);
    const registry = disk.contents.get(REGISTRY);
    expect(await cli(["init"], deps)).toBe(0);
    expect(disk.contents.get(REGISTRY)).toBe(registry);
    expect(disk.contents.get("/work/billing/keypin.toml")).toBe(TEMPLATE);
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
