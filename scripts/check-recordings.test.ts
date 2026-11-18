import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { checkRecordings } from "./check-recordings";

const repos: string[] = [];
const ISOLATED = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const WRITER = 'await expect(out).toMatchFileSnapshot("recordings/x.txt");\n';

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    env: ISOLATED,
  });
}

function repo(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "check-recordings-test-"));
  repos.push(cwd);
  git(cwd, "init", "-q");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "init");
  return cwd;
}

function snapshot(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.name === ".git") return [];
    if (item.isDirectory()) return snapshot(path, root);
    if (item.isSymbolicLink()) return [`${relative(root, path)} -> ${readlinkSync(path)}`];
    const { mtimeNs } = lstatSync(path, { bigint: true });
    return [`${relative(root, path)} ${mtimeNs} ${readFileSync(path, "utf8")}`];
  });
}

const writes =
  (files: Record<string, string>) =>
  (copy: string): number => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      writeFileSync(join(copy, path), text);
    }
    return 0;
  };

afterEach(() => {
  for (const cwd of repos.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("check-recordings", () => {
  test("passes when the tests write every recording again, and never touches the checkout", async () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    writeFileSync(join(cwd, "tests/recordings/a.txt"), "local edit\n");
    const before = snapshot(cwd);
    expect(
      await checkRecordings(cwd, writes({ "tests/recordings/a.txt": "regenerated\n" })),
    ).toEqual({
      kind: "ok",
    });
    expect(snapshot(cwd)).toEqual(before);
  });

  test("runs the tests in a copy that has every file and node_modules but no recordings", async () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    mkdirSync(join(cwd, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    let seen: string[] = [];
    await checkRecordings(cwd, (copy, files) => {
      seen = [
        ...files,
        `test file copied: ${existsSync(join(copy, "tests/a.test.ts"))}`,
        `recording copied: ${existsSync(join(copy, "tests/recordings/a.txt"))}`,
        `node_modules linked: ${lstatSync(join(copy, "node_modules")).isSymbolicLink()}`,
      ];
      return 0;
    });
    expect(seen).toEqual([
      "tests/a.test.ts",
      "test file copied: true",
      "recording copied: false",
      "node_modules linked: true",
    ]);
  });

  test("names recordings no test writes, whatever their names", async () => {
    const odd = [
      "b c.txt",
      "café.txt",
      'quo"te\ttab.txt',
      "line\nbreak.txt",
      `${"n".repeat(250)}.txt`,
    ];
    const files: Record<string, string> = {
      "tests/a.test.ts": WRITER,
      "tests/recordings/a.txt": "a\n",
    };
    for (const name of odd) files[`tests/recordings/${name}`] = `${name}\n`;
    const cwd = repo(files);
    const before = snapshot(cwd);
    const outcome = await checkRecordings(cwd, writes({ "tests/recordings/a.txt": "a\n" }));
    expect(outcome.kind).toBe("stale");
    if (outcome.kind !== "stale") return;
    expect([...outcome.paths].sort()).toEqual(odd.map((name) => `tests/recordings/${name}`).sort());
    expect(snapshot(cwd)).toEqual(before);
  });

  test("reports every recording as stale when no test writes recordings", async () => {
    const cwd = repo({ "tests/a.test.ts": "test();\n", "tests/recordings/a.txt": "a\n" });
    let ran = false;
    const outcome = await checkRecordings(cwd, () => {
      ran = true;
      return 0;
    });
    expect(outcome).toEqual({ kind: "stale", paths: ["tests/recordings/a.txt"] });
    expect(ran).toBe(false);
  });

  test("passes when there are no recordings", async () => {
    expect(await checkRecordings(repo({ "tests/a.test.ts": "test();\n" }), writes({}))).toEqual({
      kind: "ok",
    });
  });

  test("reports failing tests and leaves the checkout alone", async () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    const before = snapshot(cwd);
    expect(await checkRecordings(cwd, () => 1)).toEqual({ kind: "tests-failed" });
    expect(snapshot(cwd)).toEqual(before);
  });

  test("leaves the checkout alone when the test run throws", async () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    const before = snapshot(cwd);
    await expect(
      checkRecordings(cwd, () => {
        throw new Error("crashed");
      }),
    ).rejects.toThrow("crashed");
    expect(snapshot(cwd)).toEqual(before);
  });

  test("checks a recording once while git lists it for each side of a merge conflict", async () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "base\n" });
    git(cwd, "checkout", "-qb", "other");
    writeFileSync(join(cwd, "tests/recordings/a.txt"), "other\n");
    git(cwd, "commit", "-qam", "other");
    git(cwd, "checkout", "-q", "-");
    writeFileSync(join(cwd, "tests/recordings/a.txt"), "main\n");
    git(cwd, "commit", "-qam", "main");
    git(cwd, "merge", "-q", "--no-ff", "other");
    expect(git(cwd, "ls-files", "-u").stdout.toString()).toContain("tests/recordings/a.txt");
    expect(await checkRecordings(cwd, writes({}))).toEqual({
      kind: "stale",
      paths: ["tests/recordings/a.txt"],
    });
  });

  test("refuses a path that isn't valid UTF-8", async () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd,
      env: ISOLATED,
      input: "x\n",
    });
    const sha = blob.stdout.toString().trim();
    const name = Buffer.concat([Buffer.from("tests/recordings/bad-"), Buffer.from([0xff])]);
    const line = Buffer.concat([Buffer.from(`100644 ${sha}\t`), name, Buffer.from("\n")]);
    spawnSync("git", ["update-index", "--index-info"], { cwd, env: ISOLATED, input: line });
    await expect(checkRecordings(cwd, writes({}))).rejects.toThrow("valid UTF-8");
  });

  test("doesn't count its own test file as a recording writer", async () => {
    const cwd = repo({
      "scripts/check-recordings.test.ts": WRITER,
      "tests/recordings/a.txt": "a\n",
    });
    let ran = false;
    const outcome = await checkRecordings(cwd, () => {
      ran = true;
      return 0;
    });
    expect(outcome).toEqual({ kind: "stale", paths: ["tests/recordings/a.txt"] });
    expect(ran).toBe(false);
  });

  test("stops when git can't list the files", async () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    writeFileSync(join(cwd, ".git/index"), "garbage");
    await expect(checkRecordings(cwd, writes({}))).rejects.toThrow("git ls-files failed");
  });

  test("copies no symlinks, and refuses tests that write through one", async () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "tests/recordings/a.txt": "a\n",
      "lib/x.ts": "x\n",
      "loop/y.ts": "y\n",
    });
    const outside = mkdtempSync(join(tmpdir(), "check-recordings-test-"));
    repos.push(outside);
    writeFileSync(join(outside, "x.ts"), "sentinel\n");
    writeFileSync(join(cwd, "tests/recordings/a.txt"), "local edit\n");
    symlinkSync(join(cwd, "tests/recordings"), join(cwd, "tests/snapshots"));
    mkdirSync(join(cwd, "other"));
    symlinkSync("../tests", join(cwd, "other/link"));
    rmSync(join(cwd, "lib"), { recursive: true });
    symlinkSync(outside, join(cwd, "lib"));
    rmSync(join(cwd, "loop"), { recursive: true });
    symlinkSync("loop", join(cwd, "loop"));
    const before = [snapshot(cwd), snapshot(outside)];
    let links: string[] = [];
    const outcome = await checkRecordings(cwd, (copy) => {
      links = ["tests/snapshots", "other/link", "lib"].filter(
        (path) => lstatSync(join(copy, path), { throwIfNoEntry: false }) !== undefined,
      );
      return writes({
        "tests/snapshots/a.txt": "regenerated\n",
        "other/link/recordings/a.txt": "regenerated\n",
        "lib/x.ts": "regenerated\n",
      })(copy);
    });
    expect(links).toEqual([]);
    expect(outcome.kind).toBe("symlinks");
    if (outcome.kind !== "symlinks") return;
    expect([...outcome.paths].sort()).toEqual(["lib", "other/link", "tests/snapshots"]);
    expect([snapshot(cwd), snapshot(outside)]).toEqual(before);
  });

  test("refuses symlinked recordings and recordings folders, before running anything", async () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "elsewhere/a.txt": "a\n",
      "tests/recordings/b.txt": "b\n",
      "replaced/recordings/c.txt": "c\n",
      "looped/recordings/d.txt": "d\n",
    });
    symlinkSync("b.txt", join(cwd, "tests/recordings/link.txt"));
    mkdirSync(join(cwd, "tests/nested"));
    symlinkSync(join(cwd, "elsewhere"), join(cwd, "tests/nested/recordings"));
    rmSync(join(cwd, "replaced/recordings"), { recursive: true });
    symlinkSync("../tests/a.test.ts", join(cwd, "replaced/recordings"));
    rmSync(join(cwd, "looped/recordings"), { recursive: true });
    symlinkSync("recordings", join(cwd, "looped/recordings"));
    const before = snapshot(cwd);
    let ran = false;
    const outcome = await checkRecordings(cwd, () => {
      ran = true;
      return 0;
    });
    expect(outcome.kind).toBe("symlinks");
    if (outcome.kind !== "symlinks") return;
    expect([...new Set(outcome.paths)].sort()).toEqual([
      "looped/recordings",
      "looped/recordings/d.txt",
      "replaced/recordings",
      "replaced/recordings/c.txt",
      "tests/nested/recordings",
      "tests/recordings/link.txt",
    ]);
    expect(ran).toBe(false);
    expect(snapshot(cwd)).toEqual(before);
  });

  test("ignores a recording already deleted from disk", async () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "tests/recordings/a.txt": "a\n",
      "tests/recordings/gone.txt": "g\n",
    });
    rmSync(join(cwd, "tests/recordings/gone.txt"));
    expect(await checkRecordings(cwd, writes({ "tests/recordings/a.txt": "a\n" }))).toEqual({
      kind: "ok",
    });
  });

  test("treats recordings under a folder replaced by a file as deleted", async () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "tests/recordings/gone.txt": "g\n",
      "other/recordings/b.txt": "b\n",
    });
    rmSync(join(cwd, "tests/recordings"), { recursive: true });
    writeFileSync(join(cwd, "tests/recordings"), "now a file\n");
    expect(await checkRecordings(cwd, writes({ "other/recordings/b.txt": "b\n" }))).toEqual({
      kind: "ok",
    });
  });

  test("removes its temporary files when cancelled mid-run", async () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    const tmp = mkdtempSync(join(tmpdir(), "check-recordings-test-"));
    const bin = mkdtempSync(join(tmpdir(), "check-recordings-test-"));
    repos.push(tmp, bin);
    const bun = spawnSync("sh", ["-c", "command -v bun"]).stdout.toString().trim();
    const started = join(bin, "started");
    writeFileSync(join(bin, "bun"), `#!/bin/sh\ntouch '${started}'\nexec sleep 30\n`, {
      mode: 0o755,
    });
    const script = fileURLToPath(new URL("check-recordings.ts", import.meta.url));
    const child = spawn(bun, [script], {
      cwd,
      env: { ...ISOLATED, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp },
      stdio: "ignore",
    });
    while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 20));
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(143);
    expect(readdirSync(tmp)).toEqual([]);
  });
});
