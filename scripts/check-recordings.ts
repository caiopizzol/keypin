import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
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
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOTDIR" || code === "ELOOP") return undefined;
    throw error;
  }
}

function throughSymlink(cwd: string, path: string): boolean {
  for (let part = path; part !== "."; part = dirname(part)) {
    if (entry(join(cwd, part))?.isSymbolicLink()) return true;
  }
  return false;
}

function plainFile(cwd: string, path: string): boolean {
  if (!entry(join(cwd, path))?.isFile()) return false;
  for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
    if (!entry(join(cwd, dir))?.isDirectory()) return false;
  }
  return true;
}

function copyWithoutLinks(cwd: string, copy: string, skip: Set<string>): string[] {
  const files = paths(git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  const links = files.filter((path) => entry(join(cwd, path))?.isSymbolicLink());
  for (const path of files) {
    if (skip.has(path) || !plainFile(cwd, path)) continue;
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    copyFileSync(join(cwd, path), join(copy, path));
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
    if (basename(path) !== "node_modules" || entry(join(copy, path))) continue;
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    symlinkSync(join(cwd, path), join(copy, path));
  }
  return links;
}

export async function checkRecordings(
  cwd: string,
  runTests: (copy: string, files: string[]) => Promise<number | null> | number | null,
  tmp = tmpdir(),
): Promise<Outcome> {
  const listed = (pathspec: string) =>
    paths(
      git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", pathspec]),
    );
  const listedRecordings = listed("*/recordings/*");
  const symlinks = [...listed("*/recordings"), ...listedRecordings].filter((path) =>
    throughSymlink(cwd, path),
  );
  if (symlinks.length > 0) return { kind: "symlinks", paths: symlinks };
  const recordings = new Set(listedRecordings.filter((path) => plainFile(cwd, path)));
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

  const copy = mkdtempSync(join(tmp, "check-recordings-"));
  try {
    const links = copyWithoutLinks(cwd, copy, recordings);
    const status = writers.length > 0 ? await runTests(copy, writers) : 0;
    if (status !== 0) return { kind: "tests-failed" };
    const aliased = links.filter((path) => entry(join(copy, path)) !== undefined);
    if (aliased.length > 0) return { kind: "symlinks", paths: aliased };
    const stale = [...recordings].filter((path) => entry(join(copy, path)) === undefined);
    return stale.length > 0 ? { kind: "stale", paths: stale } : { kind: "ok" };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function vitest(log: string, started: (child: ChildProcess) => void) {
  return async (copy: string, files: string[]): Promise<number | null> => {
    const env = { ...process.env };
    delete env.CI;
    const out = openSync(log, "w");
    try {
      const child = spawn("bun", ["--bun", "vp", "test", ...files, "--update"], {
        cwd: copy,
        env,
        stdio: ["ignore", out, out],
      });
      started(child);
      return await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
    } finally {
      closeSync(out);
    }
  };
}

async function print(chunks: AsyncIterable<Buffer> | string[]) {
  for await (const chunk of chunks) {
    if (!process.stderr.write(chunk)) await once(process.stderr, "drain");
  }
}

async function report(outcome: Outcome, log: string): Promise<number> {
  switch (outcome.kind) {
    case "ok":
      return 0;
    case "symlinks":
      await print([
        `Recordings can't be checked through a symlink. Fix these paths:\n${outcome.paths.join("\n")}\n`,
      ]);
      return 1;
    case "stale":
      await print([
        `No test writes these recordings anymore. Delete them:\n${outcome.paths.join("\n")}\n`,
      ]);
      return 1;
    case "tests-failed":
      await print(createReadStream(log));
      return 1;
  }
}

if (import.meta.main) {
  const work = mkdtempSync(join(tmpdir(), "check-recordings-"));
  const log = join(work, "test.log");
  let child: ChildProcess | undefined;
  for (const [signal, code] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      child?.kill(signal);
      rmSync(work, { recursive: true, force: true });
      process.exit(code);
    });
  }
  try {
    const outcome = await checkRecordings(
      process.cwd(),
      vitest(log, (c) => (child = c)),
      work,
    );
    process.exitCode = await report(outcome, log);
  } catch (error) {
    await print([`${error instanceof Error ? error.message : String(error)}\n`]);
    process.exitCode = 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
