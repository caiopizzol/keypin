import { spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export type Outcome =
  | { kind: "ok" }
  | { kind: "symlinks"; paths: string[] }
  | { kind: "stale"; paths: string[] }
  | { kind: "tests-failed" }
  | { kind: "not-restored"; paths: string[] };

function git(cwd: string, args: string[], noMatch = false): Buffer {
  const result = spawnSync("git", args, { cwd, maxBuffer: Number.POSITIVE_INFINITY });
  if (result.status !== 0 && !(noMatch && result.status === 1)) {
    const reason = result.stderr.toString().trim() || `exit ${result.status}`;
    throw new Error(`git ${args[0]} failed: ${reason}`);
  }
  return result.stdout;
}

function paths(output: Buffer): string[] {
  const found = new Set<string>();
  let start = 0;
  for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
    const bytes = output.subarray(start, end);
    const path = bytes.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(bytes)) {
      throw new Error(`Rename this file to valid UTF-8: ${path}`);
    }
    found.add(path);
    start = end + 1;
  }
  return [...found];
}

const entry = (path: string) => lstatSync(path, { throwIfNoEntry: false });

function throughSymlink(cwd: string, path: string): boolean {
  for (let part = path; part !== "." && part !== "/"; part = dirname(part)) {
    if (entry(join(cwd, part))?.isSymbolicLink()) return true;
  }
  return false;
}

export const aside = (path: string) => join(dirname(path), `.${basename(path)}.check-recordings`);

function putBack(path: string): boolean {
  try {
    renameSync(aside(path), path);
    return true;
  } catch {
    return false;
  }
}

export function checkRecordings(
  cwd: string,
  runTests: (files: string[]) => number | null,
): Outcome {
  const listed = (pathspec: string) =>
    paths(
      git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", pathspec]),
    );
  const recordings = listed("*/recordings/*");
  const symlinks = [...listed("*/recordings"), ...recordings].filter((path) =>
    throughSymlink(cwd, path),
  );
  if (symlinks.length > 0) return { kind: "symlinks", paths: symlinks };
  const files = recordings.filter((path) => entry(join(cwd, path))?.isFile());
  if (files.length === 0) return { kind: "ok" };
  const writers = paths(
    git(
      cwd,
      [
        "grep",
        "-lz",
        "--untracked",
        "toMatchFileSnapshot",
        "--",
        "*.test.ts",
        ":(exclude)scripts/check-recordings.test.ts",
      ],
      true,
    ),
  );
  const leftover = files.filter((path) => entry(aside(join(cwd, path))) !== undefined);
  if (leftover.length > 0) {
    throw new Error(`Remove the leftover backups next to: ${leftover.join(", ")}`);
  }

  const moved: string[] = [];
  let outcome: Outcome = { kind: "ok" };
  let thrown: { error: unknown } | null = null;
  try {
    for (const path of files) {
      renameSync(join(cwd, path), aside(join(cwd, path)));
      moved.push(path);
    }
    const status = writers.length > 0 ? runTests(writers) : 0;
    const stale = moved.filter((path) => entry(join(cwd, path)) === undefined);
    if (status !== 0) outcome = { kind: "tests-failed" };
    else if (stale.length > 0) outcome = { kind: "stale", paths: stale };
  } catch (error) {
    thrown = { error };
  }

  const failed = moved.filter((path) => !putBack(join(cwd, path)));
  if (failed.length > 0) return { kind: "not-restored", paths: failed };
  if (thrown) throw thrown.error;
  return outcome;
}

function vitest(log: string) {
  return (files: string[]): number | null => {
    const env = { ...process.env };
    delete env.CI;
    const out = openSync(log, "w");
    try {
      return spawnSync("bun", ["--bun", "vp", "test", ...files, "--update"], {
        env,
        stdio: ["ignore", out, out],
      }).status;
    } finally {
      closeSync(out);
    }
  };
}

function printFile(path: string) {
  const file = openSync(path, "r");
  const chunk = Buffer.alloc(64 * 1024);
  try {
    for (let read = readSync(file, chunk); read > 0; read = readSync(file, chunk)) {
      writeSync(2, chunk.subarray(0, read));
    }
  } finally {
    closeSync(file);
  }
}

function report(outcome: Outcome, log: string): number {
  const list = (title: string, found: string[]) =>
    process.stderr.write(`${title}\n${found.join("\n")}\n`);
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
      printFile(log);
      return 1;
    case "not-restored":
      list(
        "Couldn't put these recordings back. Each original is next to it, named .<name>.check-recordings:",
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
  const logs = mkdtempSync(join(tmpdir(), "check-recordings-log-"));
  const log = join(logs, "test.log");
  try {
    process.exitCode = report(checkRecordings(process.cwd(), vitest(log)), log);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
}
