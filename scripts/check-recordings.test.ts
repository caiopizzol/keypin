import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { checkRecordings, type TestRun } from "./check-recordings";

const repos: string[] = [];
const WRITER = 'await expect(out).toMatchFileSnapshot("recordings/x.txt");\n';

function repo(files: Record<string, string>, commit = true): string {
  const cwd = mkdtempSync(join(tmpdir(), "check-recordings-test-"));
  repos.push(cwd);
  spawnSync("git", ["init", "-q"], { cwd });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  if (commit) {
    spawnSync("git", ["add", "-A"], { cwd });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd,
    });
  }
  return cwd;
}

const passing = (cwd: string, writes: Record<string, string>) => (): TestRun => {
  for (const [path, text] of Object.entries(writes)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  return { status: 0, output: "" };
};

const read = (cwd: string, path: string) => readFileSync(join(cwd, path), "utf8");

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

afterEach(() => {
  for (const cwd of repos.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", cwd]);
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("check-recordings", () => {
  test("passes when the tests write every recording again, and keeps local edits", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    writeFileSync(join(cwd, "tests/recordings/a.txt"), "edited\n");
    const run = passing(cwd, { "tests/recordings/a.txt": "regenerated\n" });
    expect(checkRecordings(cwd, run)).toEqual({ kind: "ok" });
    expect(read(cwd, "tests/recordings/a.txt")).toBe("edited\n");
  });

  test("names recordings no test writes, whatever characters their names use", () => {
    const odd = ["b c.txt", "café.txt", 'quo"te\ttab.txt', "line\nbreak.txt"];
    const files: Record<string, string> = {
      "tests/a.test.ts": WRITER,
      "tests/recordings/a.txt": "a\n",
    };
    for (const name of odd) files[`tests/recordings/${name}`] = `${name}\n`;
    const cwd = repo(files);
    const outcome = checkRecordings(cwd, passing(cwd, { "tests/recordings/a.txt": "a\n" }));
    expect(outcome).toEqual({
      kind: "stale",
      paths: odd.map((name) => `tests/recordings/${name}`).sort(),
    });
    for (const name of odd) expect(read(cwd, `tests/recordings/${name}`)).toBe(`${name}\n`);
  });

  test("reports every recording as stale when no test writes recordings", () => {
    const cwd = repo({ "tests/a.test.ts": "test();\n", "tests/recordings/a.txt": "a\n" });
    let ran = false;
    const outcome = checkRecordings(cwd, () => {
      ran = true;
      return { status: 0, output: "" };
    });
    expect(outcome).toEqual({ kind: "stale", paths: ["tests/recordings/a.txt"] });
    expect(ran).toBe(false);
  });

  test("passes when there are no recordings", () => {
    expect(checkRecordings(repo({ "tests/a.test.ts": "test();\n" }), passing("", {}))).toEqual({
      kind: "ok",
    });
  });

  test("refuses recordings reached through a symlink, before touching anything", () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "elsewhere/a.txt": "a\n",
      "tests/recordings/b.txt": "b\n",
    });
    symlinkSync("b.txt", join(cwd, "tests/recordings/link.txt"));
    mkdirSync(join(cwd, "tests/nested"));
    symlinkSync("../../elsewhere", join(cwd, "tests/nested/recordings"));
    spawnSync("git", ["add", "-A"], { cwd });
    const outcome = checkRecordings(cwd, passing(cwd, {}));
    expect(outcome).toEqual({
      kind: "symlinks",
      paths: ["tests/nested/recordings", "tests/recordings/link.txt"],
    });
    expect(read(cwd, "elsewhere/a.txt")).toBe("a\n");
  });

  test("prints the test output when the tests fail, and restores the recordings", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    const outcome = checkRecordings(cwd, () => ({ status: 1, output: "boom\n" }));
    expect(outcome).toEqual({ kind: "tests-failed", output: "boom\n" });
    expect(read(cwd, "tests/recordings/a.txt")).toBe("a\n");
  });

  test("restores the recordings when the test run throws", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    expect(() =>
      checkRecordings(cwd, () => {
        throw new Error("crashed");
      }),
    ).toThrow("crashed");
    expect(read(cwd, "tests/recordings/a.txt")).toBe("a\n");
  });

  test("keeps the backup and names the files when one can't be put back", () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "tests/recordings/a/a.txt": "a\n",
      "tests/recordings/b/b.txt": "b\n",
    });
    const outcome = checkRecordings(cwd, () => {
      chmodSync(join(cwd, "tests/recordings/a"), 0o555);
      return { status: 0, output: "" };
    });
    expect(outcome.kind).toBe("not-restored");
    if (outcome.kind !== "not-restored") return;
    expect(outcome.paths).toEqual(["tests/recordings/a/a.txt"]);
    expect(readFileSync(join(outcome.aside, "tests/recordings/a/a.txt"), "utf8")).toBe("a\n");
    expect(read(cwd, "tests/recordings/b/b.txt")).toBe("b\n");
    rmSync(outcome.aside, { recursive: true, force: true });
  });

  test("stops when git can't list the files", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    writeFileSync(join(cwd, ".git/index"), "garbage");
    expect(() => checkRecordings(cwd, passing(cwd, {}))).toThrow("git ls-files failed");
    expect(existsSync(join(cwd, "tests/recordings/a.txt"))).toBe(true);
  });

  test("keeps each recording's modification time", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    const old = new Date("2020-01-02T03:04:05Z");
    utimesSync(join(cwd, "tests/recordings/a.txt"), old, old);
    expect(checkRecordings(cwd, passing(cwd, { "tests/recordings/a.txt": "a\n" }))).toEqual({
      kind: "ok",
    });
    expect(statSync(join(cwd, "tests/recordings/a.txt")).mtime.getTime()).toBe(old.getTime());
  });

  test("checks a recording once while git lists it for each side of a merge conflict", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "base\n" });
    git(cwd, "checkout", "-qb", "other");
    writeFileSync(join(cwd, "tests/recordings/a.txt"), "other\n");
    git(cwd, "commit", "-qam", "other");
    git(cwd, "checkout", "-q", "-");
    writeFileSync(join(cwd, "tests/recordings/a.txt"), "main\n");
    git(cwd, "commit", "-qam", "main");
    git(cwd, "merge", "-q", "other");
    const outcome = checkRecordings(cwd, passing(cwd, {}));
    expect(outcome).toEqual({ kind: "stale", paths: ["tests/recordings/a.txt"] });
    expect(existsSync(join(cwd, "tests/recordings/a.txt"))).toBe(true);
  });

  test("refuses a path that isn't valid UTF-8", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: "x\n" });
    const sha = blob.stdout.toString().trim();
    const name = Buffer.concat([Buffer.from("tests/recordings/bad-"), Buffer.from([0xff])]);
    const line = Buffer.concat([Buffer.from(`100644 ${sha}\t`), name, Buffer.from("\n")]);
    spawnSync("git", ["update-index", "--index-info"], { cwd, input: line });
    expect(() => checkRecordings(cwd, passing(cwd, {}))).toThrow("valid UTF-8");
    expect(read(cwd, "tests/recordings/a.txt")).toBe("a\n");
  });

  test("doesn't count its own test file as a recording writer", () => {
    const cwd = repo({
      "scripts/check-recordings.test.ts": WRITER,
      "tests/recordings/a.txt": "a\n",
    });
    let ran = false;
    const outcome = checkRecordings(cwd, () => {
      ran = true;
      return { status: 0, output: "" };
    });
    expect(outcome).toEqual({ kind: "stale", paths: ["tests/recordings/a.txt"] });
    expect(ran).toBe(false);
  });
});
