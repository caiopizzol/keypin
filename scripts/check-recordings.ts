import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Outcome =
  | { kind: "ok" }
  | { kind: "symlinks"; paths: string[] }
  | { kind: "stale"; paths: string[] }
  | { kind: "tests-failed" };

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

function unreachable(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function linkToFile(path: string): boolean {
  return isSymlink(path) && !isDirectory(path);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (unreachable(error)) return false;
    throw error;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (unreachable(error)) return false;
    throw error;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (unreachable(error)) return false;
    throw error;
  }
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (unreachable(error)) return undefined;
    throw error;
  }
}

export function checkRecordings(
  cwd: string,
  runTests: (files: string[], log: string) => number | null,
): Outcome {
  const listed = paths(
    git(cwd, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*/recordings/*",
    ]),
  );
  const symlinks = listed.filter((path) => linkToFile(join(cwd, path)));
  if (symlinks.length > 0) return { kind: "symlinks", paths: symlinks };
  const recordings = listed.filter((path) => isFile(join(cwd, path)));
  if (recordings.length === 0) return { kind: "ok" };
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

  const used = new Set<string>();
  if (writers.length > 0) {
    const dir = mkdtempSync(join(tmpdir(), "check-recordings-"));
    try {
      const log = join(dir, "used");
      writeFileSync(log, "");
      if (runTests(writers, log) !== 0) return { kind: "tests-failed" };
      for (const path of paths(readFileSync(log))) {
        const real = realPath(path);
        if (real) used.add(real);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const stale = recordings.filter((path) => {
    const real = realPath(join(cwd, path));
    return real !== undefined && !used.has(real);
  });
  return stale.length > 0 ? { kind: "stale", paths: stale } : { kind: "ok" };
}

function vitest(files: string[], log: string): number | null {
  return spawnSync("bun", ["--bun", "vp", "test", ...files, "--update=none"], {
    stdio: "inherit",
    env: { ...process.env, CI: "true", RECORDINGS_LOG: log },
  }).status;
}

if (import.meta.main) {
  try {
    const outcome = checkRecordings(process.cwd(), vitest);
    if (outcome.kind === "symlinks") {
      process.stderr.write(
        `Recordings must be plain files, not symlinks. Replace these:\n${outcome.paths.join("\n")}\n`,
      );
    }
    if (outcome.kind === "stale") {
      process.stderr.write(
        `No test uses these recordings anymore. Delete them:\n${outcome.paths.join("\n")}\n`,
      );
    }
    process.exitCode = outcome.kind === "ok" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
