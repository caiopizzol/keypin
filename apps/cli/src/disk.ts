import { type BigIntStats, constants, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { type Files, withoutSignIn } from "@keypin/core";
import type { CreateFile, FolderEntry, HeldLock, Lock, ReplaceFile } from "./deps";
import { errorCode } from "./errors";
import { onSignals } from "./launch";

export const diskFiles: Files = {
  async read(path) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`${path} isn't a regular file`);
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  },
  async write(path, text) {
    await privateFolder(dirname(path));
    const handle = await open(path, PRIVATE_WRITE, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  },
  async rename(from, to) {
    await rename(from, to);
  },
};

const PRIVATE_WRITE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

async function privateFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await chmod(folder, 0o700);
}

export const createFile: CreateFile = async (path, text) => {
  const found = await kindOf(path);
  if (found !== "missing") return found;
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(text);
    await handle.close();
    return "created";
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const now = await kindOf(path);
    return now === "missing" ? "exists" : now;
  }
};

export function replaceFileWith(beforeRecheck: () => Promise<void>): ReplaceFile {
  return async (path, expected, text) => {
    const first = await readExpected(path, expected);
    if (typeof first === "string") return first;
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.chmod(Number(first.mode) & 0o7777);
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await beforeRecheck();
      const now = await readExpected(path, expected);
      if (typeof now === "string") return now;
      if (!sameFile(first, now)) return "changed";
      await rename(temporary, path);
      return "replaced";
    } finally {
      await rm(temporary, { force: true });
    }
  };
}

export const replaceFile = replaceFileWith(async () => {});

type Identity = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "mode">;

function sameFile(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

async function readExpected(
  path: string,
  expected: string,
): Promise<"changed" | "link" | Identity> {
  if ((await kindOf(path)) === "link") return "link";
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ELOOP") return "link";
    if (errorCode(error) === "ENOENT") return "changed";
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if ((await handle.readFile("utf8")) !== expected) return "changed";
    const found = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (found === null) return "changed";
    if (found.isSymbolicLink()) return "link";
    return sameFile(opened, found) ? opened : "changed";
  } finally {
    await handle.close();
  }
}

export async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function kindOf(path: string): Promise<"missing" | "exists" | "link"> {
  try {
    const found = await lstat(path);
    if (found.isSymbolicLink()) return "link";
    if (!found.isFile()) throw new Error(`${path} isn't a file`);
    return "exists";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

export async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function listFolder(path: string): Promise<FolderEntry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    kind: entry.isFile() ? "file" : entry.isDirectory() ? "folder" : "other",
  }));
}

export function git(folder: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", folder, ...args],
      { maxBuffer: 64 * 1024 * 1024, env: withoutSignIn(process.env) },
      (error, stdout) => {
        resolve(error ? null : String(stdout));
      },
    );
  });
}

export const diskLock: Lock = async (path) => {
  await privateFolder(dirname(path));
  if (await take(path)) return { held: true, lock: held(path) };
  const pid = await holderOf(path);
  return { held: false, holder: { pid, running: pid === null ? null : isRunning(pid) } };
};

async function take(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

async function holderOf(path: string): Promise<number | null> {
  const text = await diskFiles.read(path);
  const pid = text?.match(/^(\d+)\n?$/)?.[1];
  return pid === undefined ? null : Number(pid);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function held(path: string): HeldLock {
  const stop = onSignals((signal) => {
    stop();
    rmSync(path, { force: true });
    process.kill(process.pid, signal);
  });
  return {
    async release() {
      stop();
      await rm(path, { force: true });
    },
  };
}
