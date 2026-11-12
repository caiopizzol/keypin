import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { LAUNCHER } from "../compile";

let root = "";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keypin-launcher-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function executable(path: string, text: string) {
  await writeFile(path, text);
  await chmod(path, 0o755);
}

async function install(cpus: string[], os = "darwin") {
  const modules = join(root, "lib/node_modules");
  await mkdir(join(modules, "keypin/bin"), { recursive: true });
  await copyFile(LAUNCHER, join(modules, "keypin/bin/keypin"));
  await chmod(join(modules, "keypin/bin/keypin"), 0o755);
  for (const cpu of cpus) {
    const bin = join(modules, `@keypin/cli-${os}-${cpu}/bin`);
    await mkdir(bin, { recursive: true });
    await executable(join(bin, "keypin"), `#!/bin/sh\necho "${os}-${cpu}"\nexec env\n`);
  }
  await mkdir(join(root, "bin"));
  await symlink("../lib/node_modules/keypin/bin/keypin", join(root, "bin/keypin"));
}

async function run(system: string, machine: string, env: Record<string, string> = {}) {
  const tools = join(root, "tools");
  await mkdir(tools, { recursive: true });
  await executable(
    join(tools, "uname"),
    `#!/bin/sh\ncase $1 in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
  );
  const child = Bun.spawn([join(root, "bin/keypin"), "--version"], {
    env: { PATH: `${tools}:/usr/bin:/bin`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { ran: stdout.split("\n")[0], env: stdout, stderr, code };
}

describe("launcher.sh", () => {
  test("an arm64 shell on a Mac runs the arm64 build", async () => {
    await install(["arm64", "x64"]);
    expect((await run("Darwin", "arm64")).ran).toBe("darwin-arm64");
  });

  test("an arm64 shell runs the x64 build an x64 npm installed under Rosetta", async () => {
    await install(["x64"]);
    expect((await run("Darwin", "arm64")).ran).toBe("darwin-x64");
  });

  test("an x64 shell on a Mac prefers the x64 build", async () => {
    await install(["arm64", "x64"]);
    expect((await run("Darwin", "x86_64")).ran).toBe("darwin-x64");
  });

  test("Linux never runs the other architecture's build, and needs glibc's loader", async () => {
    await install(["arm64"], "linux");
    const result = await run("Linux", "x86_64");
    expect(result.code).toBe(1);
    expect(result.env).toBe("");
    expect(result.stderr).toContain(
      existsSync("/lib64/ld-linux-x86-64.so.2")
        ? "the package @keypin/cli-linux-x64 isn't installed"
        : "keypin's Linux build needs glibc, and this system has no /lib64/ld-linux-x86-64.so.2",
    );
  });

  test("no build for this Mac names the missing package", async () => {
    await install([]);
    const result = await run("Darwin", "arm64");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the package @keypin/cli-darwin-arm64 isn't installed");
  });

  test("names the launcher uses keep the caller's exported values", async () => {
    await install(["arm64"]);
    const names = ["self", "link", "keypin", "os", "arch", "cpu", "cpus", "loader", "binary"];
    const given = Object.fromEntries(names.map((name) => [name, `caller's ${name}`]));
    const result = await run("Darwin", "arm64", given);
    expect(result.code).toBe(0);
    for (const name of names) expect(result.env).toContain(`\n${name}=caller's ${name}\n`);
  });

  test("names the launcher uses stay out of keypin's environment when the caller has none", async () => {
    await install(["arm64"]);
    const result = await run("Darwin", "arm64");
    expect(result.env).not.toMatch(/^(self|link|keypin|os|arch|cpu|cpus|loader|binary)=/m);
  });
});
