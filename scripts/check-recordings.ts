import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TestRun {
  status: number | null;
  output: string;
}

export type Outcome =
  | { kind: "ok" }
  | { kind: "symlinks"; paths: string[] }
  | { kind: "stale"; paths: string[] }
  | { kind: "tests-failed"; output: string }
  | { kind: "not-restored"; paths: string[]; aside: string };

function git(cwd: string, args: string[], noMatch = false): string[] {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && !(noMatch && result.status === 1)) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.split("\0").filter((path) => path !== "");
}

const entry = (path: string) => lstatSync(path, { throwIfNoEntry: false });

function throughSymlink(cwd: string, path: string): boolean {
  for (let part = path; part !== "." && part !== "/"; part = dirname(part)) {
    if (entry(join(cwd, part))?.isSymbolicLink()) return true;
  }
  return false;
}

function putBack(cwd: string, aside: string, path: string): boolean {
  try {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    copyFileSync(join(aside, path), join(cwd, path));
    return true;
  } catch {
    return false;
  }
}

export function checkRecordings(cwd: string, runTests: (files: string[]) => TestRun): Outcome {
  const listed = (pathspec: string) =>
    git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", pathspec]);
  const recordings = listed("*/recordings/*");
  const symlinks = [...listed("*/recordings"), ...recordings].filter((path) =>
    throughSymlink(cwd, path),
  );
  if (symlinks.length > 0) return { kind: "symlinks", paths: symlinks };
  const saved = recordings.filter((path) => entry(join(cwd, path))?.isFile());
  if (saved.length === 0) return { kind: "ok" };
  const writers = git(
    cwd,
    ["grep", "-lz", "--untracked", "toMatchFileSnapshot", "--", "*.test.ts"],
    true,
  );

  const aside = mkdtempSync(join(tmpdir(), "check-recordings-"));
  try {
    for (const path of saved) {
      mkdirSync(dirname(join(aside, path)), { recursive: true });
      copyFileSync(join(cwd, path), join(aside, path));
    }
  } catch (error) {
    rmSync(aside, { recursive: true, force: true });
    throw error;
  }

  let outcome: Outcome = { kind: "ok" };
  let thrown: { error: unknown } | null = null;
  try {
    for (const path of saved) rmSync(join(cwd, path));
    const run = writers.length > 0 ? runTests(writers) : null;
    const stale = saved.filter((path) => entry(join(cwd, path)) === undefined);
    if (run && run.status !== 0) outcome = { kind: "tests-failed", output: run.output };
    else if (stale.length > 0) outcome = { kind: "stale", paths: stale };
  } catch (error) {
    thrown = { error };
  }

  const failed = saved.filter((path) => !putBack(cwd, aside, path));
  if (failed.length > 0) return { kind: "not-restored", paths: failed, aside };
  rmSync(aside, { recursive: true, force: true });
  if (thrown) throw thrown.error;
  return outcome;
}

function vitest(files: string[]): TestRun {
  const env = { ...process.env };
  delete env.CI;
  const result = spawnSync("bun", ["--bun", "vp", "test", ...files, "--update"], {
    env,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function report(outcome: Outcome): number {
  const list = (title: string, paths: string[]) =>
    process.stderr.write(`${title}\n${paths.join("\n")}\n`);
  switch (outcome.kind) {
    case "ok":
      return 0;
    case "symlinks":
      list(
        "Recordings must be plain files outside any symlinked folder. Fix these paths:",
        outcome.paths,
      );
      return 1;
    case "stale":
      list("No test writes these recordings anymore. Delete them:", outcome.paths);
      return 1;
    case "tests-failed":
      process.stderr.write(outcome.output);
      return 1;
    case "not-restored":
      list(
        `Couldn't put these recordings back. The originals are in ${outcome.aside}:`,
        outcome.paths,
      );
      return 1;
  }
}

if (import.meta.main) {
  process.on("SIGHUP", () => {
    process.exitCode = 129;
  });
  process.on("SIGINT", () => {
    process.exitCode = 130;
  });
  process.on("SIGTERM", () => {
    process.exitCode = 143;
  });
  try {
    process.exitCode = report(checkRecordings(process.cwd(), vitest));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
