import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
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

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-recordings-test-"));
  repos.push(dir);
  return dir;
}

function repo(files: Record<string, string>): string {
  const cwd = temp();
  git(cwd, "init", "-q");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "init");
  return cwd;
}

const uses =
  (cwd: string, ...used: string[]) =>
  (_files: string[], log: string): number => {
    appendFileSync(log, used.map((path) => `${join(cwd, path)}\0`).join(""));
    return 0;
  };

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-recordings", () => {
  test("passes when the tests use every recording, and runs only the files that write recordings", () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "tests/b.test.ts": "test();\n",
      "tests/recordings/a.txt": "a\n",
    });
    let ran: string[] = [];
    const outcome = checkRecordings(cwd, (files, log) => {
      ran = files;
      return uses(cwd, "tests/recordings/a.txt")(files, log);
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(ran).toEqual(["tests/a.test.ts"]);
  });

  test("names recordings no test uses, whatever their names", () => {
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
    const outcome = checkRecordings(cwd, uses(cwd, "tests/recordings/a.txt"));
    expect(outcome.kind).toBe("stale");
    if (outcome.kind !== "stale") return;
    expect([...outcome.paths].sort()).toEqual(odd.map((name) => `tests/recordings/${name}`).sort());
  });

  test("reports every recording as stale when no test writes recordings", () => {
    const cwd = repo({ "tests/a.test.ts": "test();\n", "tests/recordings/a.txt": "a\n" });
    let ran = false;
    const outcome = checkRecordings(cwd, () => {
      ran = true;
      return 0;
    });
    expect(outcome).toEqual({ kind: "stale", paths: ["tests/recordings/a.txt"] });
    expect(ran).toBe(false);
  });

  test("passes when there are no recordings", () => {
    expect(checkRecordings(repo({ "tests/a.test.ts": WRITER }), () => 1)).toEqual({ kind: "ok" });
  });

  test("reports failing tests", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    expect(checkRecordings(cwd, () => 1)).toEqual({ kind: "tests-failed" });
  });

  test("checks a recording once while git lists it for each side of a merge conflict", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "base\n" });
    git(cwd, "checkout", "-qb", "other");
    writeFileSync(join(cwd, "tests/recordings/a.txt"), "other\n");
    git(cwd, "commit", "-qam", "other");
    git(cwd, "checkout", "-q", "-");
    writeFileSync(join(cwd, "tests/recordings/a.txt"), "main\n");
    git(cwd, "commit", "-qam", "main");
    git(cwd, "merge", "-q", "--no-ff", "other");
    expect(git(cwd, "ls-files", "-u").stdout.toString()).toContain("tests/recordings/a.txt");
    expect(checkRecordings(cwd, uses(cwd))).toEqual({
      kind: "stale",
      paths: ["tests/recordings/a.txt"],
    });
  });

  test("refuses a path that isn't valid UTF-8", () => {
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
    expect(() => checkRecordings(cwd, uses(cwd))).toThrow("valid UTF-8");
  });

  test("doesn't count its own test file as a recording writer", () => {
    const cwd = repo({
      "scripts/check-recordings.test.ts": WRITER,
      "tests/recordings/a.txt": "a\n",
    });
    let ran = false;
    const outcome = checkRecordings(cwd, () => {
      ran = true;
      return 0;
    });
    expect(outcome).toEqual({ kind: "stale", paths: ["tests/recordings/a.txt"] });
    expect(ran).toBe(false);
  });

  test("stops when git can't list the files", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    writeFileSync(join(cwd, ".git/index"), "garbage");
    expect(() => checkRecordings(cwd, uses(cwd))).toThrow("git ls-files failed");
  });

  test("counts a recording used through a symlinked folder, even an ignored one", () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "fixtures/recordings/a.txt": "a\n",
      "fixtures/recordings/b.txt": "b\n",
      ".gitignore": "ignored-alias\n",
    });
    symlinkSync("../fixtures", join(cwd, "tests/alias"));
    symlinkSync(join(cwd, "fixtures"), join(cwd, "ignored-alias"));
    const outcome = checkRecordings(
      cwd,
      uses(cwd, "tests/alias/recordings/a.txt", "ignored-alias/recordings/b.txt"),
    );
    expect(outcome).toEqual({ kind: "ok" });
  });

  test("refuses symlinked recordings, before running the tests", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/b.txt": "b\n" });
    symlinkSync("b.txt", join(cwd, "tests/recordings/link.txt"));
    symlinkSync("missing.txt", join(cwd, "tests/recordings/broken.txt"));
    let ran = false;
    const outcome = checkRecordings(cwd, () => {
      ran = true;
      return 0;
    });
    expect(outcome.kind).toBe("symlinks");
    if (outcome.kind !== "symlinks") return;
    expect([...outcome.paths].sort()).toEqual([
      "tests/recordings/broken.txt",
      "tests/recordings/link.txt",
    ]);
    expect(ran).toBe(false);
  });

  test("allows a symlinked folder inside a recordings folder", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "fixtures/recordings/data.txt": "d\n" });
    mkdirSync(join(cwd, "tests/recordings"));
    symlinkSync("../../fixtures/recordings", join(cwd, "tests/recordings/shared"));
    expect(checkRecordings(cwd, uses(cwd, "tests/recordings/shared/data.txt"))).toEqual({
      kind: "ok",
    });
  });

  test("leaves out a recording a passing test deleted during the run", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    const outcome = checkRecordings(cwd, () => {
      rmSync(join(cwd, "tests/recordings/a.txt"));
      return 0;
    });
    expect(outcome).toEqual({ kind: "ok" });
  });

  test("counts a recording a test reads through a link outside the recordings folders", () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "tests/recordings/b.txt": "b\n",
      "fixtures/recordings/data.txt": "d\n",
    });
    mkdirSync(join(cwd, "fixtures/recordings/deep"));
    symlinkSync("recordings/b.txt", join(cwd, "tests/snap.txt"));
    symlinkSync("../fixtures/recordings/deep", join(cwd, "tests/sub"));
    symlinkSync("sub/../data.txt", join(cwd, "tests/front.txt"));
    expect(checkRecordings(cwd, uses(cwd, "tests/snap.txt", "tests/front.txt"))).toEqual({
      kind: "ok",
    });
  });

  test("ignores a snapshot a test removed before the run ended", () => {
    const cwd = repo({ "tests/a.test.ts": WRITER, "tests/recordings/a.txt": "a\n" });
    expect(
      checkRecordings(cwd, uses(cwd, "tests/recordings/a.txt", "scratch/gone/recordings/x.txt")),
    ).toEqual({ kind: "ok" });
  });

  test("ignores recordings deleted from disk, or under a folder replaced by a file or a looping link", () => {
    const cwd = repo({
      "tests/a.test.ts": WRITER,
      "tests/recordings/a.txt": "a\n",
      "tests/recordings/gone.txt": "g\n",
      "replaced/recordings/b.txt": "b\n",
      "looped/recordings/c.txt": "c\n",
    });
    rmSync(join(cwd, "tests/recordings/gone.txt"));
    rmSync(join(cwd, "replaced/recordings"), { recursive: true });
    writeFileSync(join(cwd, "replaced/recordings"), "now a file\n");
    rmSync(join(cwd, "looped/recordings"), { recursive: true });
    symlinkSync("recordings", join(cwd, "looped/recordings"));
    expect(checkRecordings(cwd, uses(cwd, "tests/recordings/a.txt"))).toEqual({ kind: "ok" });
  });
});

describe("recordings-environment", () => {
  test("logs every recording path a test resolves, and nothing without RECORDINGS_LOG", async () => {
    const log = join(temp(), "used");
    writeFileSync(log, "");
    vi.stubEnv("RECORDINGS_LOG", log);
    vi.resetModules();
    const { default: logging } = await import("./recordings-environment");
    expect(await logging.resolveRawPath("/repo/tests/a.test.ts", "./recordings/a.txt")).toBe(
      "/repo/tests/recordings/a.txt",
    );
    vi.stubEnv("RECORDINGS_LOG", undefined);
    vi.resetModules();
    const { default: silent } = await import("./recordings-environment");
    await silent.resolveRawPath("/repo/tests/a.test.ts", "./recordings/b.txt");
    expect(readFileSync(log, "utf8")).toBe("/repo/tests/recordings/a.txt\0");
  });
});
