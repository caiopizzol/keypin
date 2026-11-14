import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { check, grown, LIMIT, reason } from "./check-docs-growth";

describe("grown", () => {
  test("counts added lines, and removed lines as negative", () => {
    expect(grown("a\nb\n", "a\nb\nc\nd\n")).toBe(2);
    expect(grown("a\nb\nc\n", "a\n")).toBe(-2);
    expect(grown("", "a\n")).toBe(1);
    expect(grown("", "a\nb\nc")).toBe(3);
    expect(grown("a\nb\nc\n", "")).toBe(-3);
  });

  test("a trailing newline ends the last line, it doesn't add one", () => {
    expect(grown("a", "a\n")).toBe(0);
    expect(grown("a\n", "a")).toBe(0);
    expect(grown("a\nb", "a\nb\nc\n")).toBe(1);
  });
});

describe("reason", () => {
  test("takes the first Docs-Growth value from git log", () => {
    expect(reason("\n\nnew command needs its own section\n\n")).toBe(
      "new command needs its own section",
    );
    expect(reason("\n\n")).toBeNull();
  });
});

describe("check", () => {
  let root = "";
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  const grow = (file: string, count: number) =>
    appendFileSync(join(root, file), "line\n".repeat(count));
  const commit = (message: string) => git("commit", "-qam", message);

  const baseRef = process.env.GITHUB_BASE_REF;
  beforeEach(() => {
    delete process.env.GITHUB_BASE_REF;
    root = mkdtempSync(join(tmpdir(), "keypin-docs-growth-"));
    mkdirSync(join(root, "skills/keypin"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# keypin\n");
    writeFileSync(join(root, "skills/keypin/SKILL.md"), "# skill\n");
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("add", ".");
    commit("docs: start");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "-qc", "change");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (baseRef === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = baseRef;
  });

  test("passes on main and within the limit", () => {
    expect(check(root).problems).toEqual([]);
    grow("README.md", LIMIT);
    commit("docs: a few lines");
    expect(check(root).problems).toEqual([]);
  });

  test("fails when either committed file grows past the limit", () => {
    grow("README.md", 20);
    commit("docs: long");
    grow("skills/keypin/SKILL.md", LIMIT + 1);
    expect(check(root).problems).toEqual(["README.md grew by 20 lines"]);
    commit("docs: longer");
    expect(check(root)).toMatchObject({
      problems: ["README.md grew by 20 lines", "skills/keypin/SKILL.md grew by 6 lines"],
      override: null,
    });
  });

  test("a Docs-Growth trailer in any commit of the branch is the override", () => {
    grow("README.md", 20);
    commit("docs: long\n\nDocs-Growth: the new command needs a section");
    grow("README.md", 1);
    commit("fix: typo");
    expect(check(root).override).toBe("the new command needs a section");
  });

  test("compares with origin/<GITHUB_BASE_REF> when CI sets it", () => {
    git("update-ref", "refs/remotes/origin/release", "HEAD");
    grow("README.md", 20);
    commit("docs: long");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(check(root).problems).toEqual([]);
    process.env.GITHUB_BASE_REF = "release";
    expect(check(root).problems).toEqual(["README.md grew by 20 lines"]);
  });

  test("skips when there is no origin/main to compare with", () => {
    git("update-ref", "-d", "refs/remotes/origin/main");
    expect(check(root)).toEqual({ base: null, problems: [], override: null });
  });
});
