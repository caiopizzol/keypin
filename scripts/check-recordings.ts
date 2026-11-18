import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

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

function entry(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOTDIR") return undefined;
    throw error;
  }
}

function throughSymlink(cwd: string, path: string): boolean {
  for (let part = path; part !== "." && part !== "/"; part = dirname(part)) {
    if (entry(join(cwd, part))?.isSymbolicLink()) return true;
  }
  return false;
}

function copyCheckout(cwd: string, copy: string, skip: Set<string>) {
  const files = paths(git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  for (const path of files) {
    const info = skip.has(path) ? undefined : entry(join(cwd, path));
    if (!info?.isFile() && !info?.isSymbolicLink()) continue;
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    if (info.isSymbolicLink()) symlinkSync(readlinkSync(join(cwd, path)), join(copy, path));
    else copyFileSync(join(cwd, path), join(copy, path));
  }
  const ignored = git(cwd, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  for (const path of paths(ignored).map((dir) => dir.replace(/\/$/, ""))) {
    if (basename(path) !== "node_modules") continue;
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    symlinkSync(join(cwd, path), join(copy, path));
  }
}

export function checkRecordings(
  cwd: string,
  runTests: (copy: string, files: string[]) => number | null,
): Outcome {
  const listed = (pathspec: string) =>
    paths(
      git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", pathspec]),
    );
  const listedRecordings = listed("*/recordings/*");
  const symlinks = [...listed("*/recordings"), ...listedRecordings].filter((path) =>
    throughSymlink(cwd, path),
  );
  if (symlinks.length > 0) return { kind: "symlinks", paths: symlinks };
  const recordings = new Set(listedRecordings.filter((path) => entry(join(cwd, path))?.isFile()));
  if (recordings.size === 0) return { kind: "ok" };
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

  const copy = mkdtempSync(join(tmpdir(), "check-recordings-"));
  try {
    copyCheckout(cwd, copy, recordings);
    const status = writers.length > 0 ? runTests(copy, writers) : 0;
    if (status !== 0) return { kind: "tests-failed" };
    const stale = [...recordings].filter((path) => entry(join(copy, path)) === undefined);
    return stale.length > 0 ? { kind: "stale", paths: stale } : { kind: "ok" };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function vitest(log: string) {
  return (copy: string, files: string[]): number | null => {
    const env = { ...process.env };
    delete env.CI;
    const out = openSync(log, "w");
    try {
      return spawnSync("bun", ["--bun", "vp", "test", ...files, "--update"], {
        cwd: copy,
        env,
        stdio: ["ignore", out, out],
      }).status;
    } finally {
      closeSync(out);
    }
  };
}

function writeAll(fd: number, bytes: Buffer) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let done = 0; done < bytes.length;) {
    try {
      done += writeSync(fd, bytes, done);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}

function printFile(path: string) {
  const file = openSync(path, "r");
  const chunk = Buffer.alloc(64 * 1024);
  try {
    for (let read = readSync(file, chunk); read > 0; read = readSync(file, chunk)) {
      writeAll(2, chunk.subarray(0, read));
    }
  } finally {
    closeSync(file);
  }
}

function report(outcome: Outcome, log: string): number {
  switch (outcome.kind) {
    case "ok":
      return 0;
    case "symlinks":
      writeAll(
        2,
        Buffer.from(
          `Recordings must be plain files outside any symlinked folder. Fix these paths:\n${outcome.paths.join("\n")}\n`,
        ),
      );
      return 1;
    case "stale":
      writeAll(
        2,
        Buffer.from(
          `No test writes these recordings anymore. Delete them:\n${outcome.paths.join("\n")}\n`,
        ),
      );
      return 1;
    case "tests-failed":
      printFile(log);
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
