import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Files } from "@keypin/core";
import { cli } from "../../../apps/cli/src/cli";
import type { Deps, Lock, Writer } from "../../../apps/cli/src/deps";
import {
  createFile,
  diskFiles,
  diskLock,
  isFolder,
  isLink,
  listFolder,
  replaceFile,
} from "../../../apps/cli/src/disk";
import { onSignals } from "../../../apps/cli/src/launch";
import {
  fakeDestination,
  fakeGithubSecrets,
  fakeProvider,
  fakeVault,
  fakeWorkerSecrets,
} from "./fakes";
import { emptyWorld, parseWorld, type World } from "./world";
import { errorCode } from "../../../apps/cli/src/errors";

const WORLD = "world.json";
const GIT_OUTPUT = 64 * 1024 * 1024;
const PASSED_ENV = ["TERM", "LANG", "LC_ALL", "SHELL", "USER", "TMPDIR"];
export const SHADOWED = ["op", "gh", "wrangler", "npx", "bunx", "keypin"];

export interface Sandbox {
  root: string;
  home: string;
  bin: string;
  world: string;
}

export function sandboxAt(root: string): Sandbox {
  return {
    root,
    home: join(root, "home"),
    bin: join(root, "bin", "keypin"),
    world: join(root, WORLD),
  };
}

export async function createSandbox(folder: string, driver: string): Promise<Sandbox> {
  await mkdir(folder, { recursive: true });
  const box = sandboxAt(await realpath(folder));
  if ((await readFile(box.world, "utf8").catch(() => null)) !== null)
    throw new Error(`${box.root} is already a sandbox; make a new one in another folder`);
  await mkdir(box.home, { recursive: true });
  await mkdir(dirname(box.bin), { recursive: true });
  await writeFile(
    box.bin,
    `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(driver)} keypin ${quote(box.root)} "$@"\n`,
  );
  await chmod(box.bin, 0o755);
  for (const tool of SHADOWED.filter((name) => name !== "keypin")) {
    const stub = join(dirname(box.bin), tool);
    await writeFile(
      stub,
      `#!/bin/sh\necho "sandbox: ${tool} isn't available here; the sandbox has no real 1Password, GitHub or Cloudflare" >&2\nexit 127\n`,
    );
    await chmod(stub, 0o755);
  }
  await saveWorld(box, emptyWorld());
  return box;
}

export async function openSandbox(folder: string): Promise<Sandbox> {
  const box = sandboxAt(await realpath(folder));
  await loadWorld(box);
  return box;
}

export async function loadWorld(box: Sandbox): Promise<World> {
  const text = await readFile(box.world, "utf8").catch(() => {
    throw new Error(`${box.root} isn't a sandbox: it has no ${WORLD}`);
  });
  return parseWorld(text, box.world);
}

export async function saveWorld(box: Sandbox, world: World): Promise<void> {
  const temporary = `${box.world}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(world, null, 2)}\n`);
  await rename(temporary, box.world);
}

export async function editWorld(box: Sandbox, change: (world: World) => void): Promise<World> {
  const world = await loadWorld(box);
  change(world);
  await saveWorld(box, world);
  return world;
}

export type Ask = (question: string) => Promise<string>;

export interface RunOptions {
  cwd: string;
  terminal?: Ask;
  stdout?: Writer;
  stderr?: Writer;
}

export async function runKeypin(
  box: Sandbox,
  args: string[],
  options: RunOptions,
): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const cwd = await realpath(options.cwd).catch(() => resolve(options.cwd));
  if (!(await contained(box, cwd))) {
    stderr.write(`sandbox: run keypin from inside ${box.root}, not ${cwd}\n`);
    return 2;
  }
  const world = await loadWorld(box);
  const before = JSON.stringify(world);
  try {
    return await cli(args, sandboxDeps(box, world, { ...options, cwd, stderr }));
  } finally {
    if (JSON.stringify(world) !== before) await saveWorld(box, world);
  }
}

function sandboxDeps(box: Sandbox, world: World, options: RunOptions & { stderr: Writer }): Deps {
  const now = () => new Date();
  const terminal = options.terminal;
  return {
    cwd: options.cwd,
    self: [box.bin],
    env: sandboxEnv(box),
    home: box.home,
    files: guardedFiles(box),
    isFolder: async (path) => (await contained(box, path)) && isFolder(path),
    listFolder: async (path) => {
      if (!(await contained(box, path))) throw new Error(`ENOENT: ${path} is outside the sandbox`);
      return listFolder(path);
    },
    git: (folder, args) => sandboxGit(box, folder, args),
    githubSecrets: async (repo, login) => fakeGithubSecrets(world, repo, login),
    workerSecrets: async (account, worker) => fakeWorkerSecrets(world, account, worker),
    createFile: async (path, text) => createFile(await writable(box, path), text),
    replaceFile: async (path, expected, text) =>
      replaceFile(await writable(box, path), expected, text),
    isLink: async (path) => (await contained(box, dirname(path))) && isLink(path),
    vault: () => fakeVault(world),
    now,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr,
    launch: (command, env) => {
      const child = Bun.spawn(command, {
        cwd: options.cwd,
        env,
        stdio: ["inherit", "inherit", "inherit"],
      });
      return { exited: child.exited, kill: (signal) => child.kill(signal) };
    },
    onSignals,
    destination: (target) => fakeDestination(world, target, now),
    provider: (spec, admin) => fakeProvider(world, spec, admin),
    lock: guardedLock(box),
    isTerminal: terminal !== undefined,
    ask: async (question) => {
      if (terminal === undefined) throw new Error("the sandbox has no terminal to ask on");
      return terminal(question);
    },
  };
}

export function sandboxEnv(box: Sandbox): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    PATH: [dirname(box.bin), ...(process.env.PATH ?? "/usr/bin:/bin").split(":")].join(":"),
    HOME: box.home,
    XDG_CONFIG_HOME: join(box.home, ".config"),
    XDG_STATE_HOME: join(box.home, ".local/state"),
  };
}

export function inside(box: Sandbox, path: string): boolean {
  const full = resolve(path);
  return full === box.root || full.startsWith(`${box.root}${sep}`);
}

export async function contained(box: Sandbox, path: string): Promise<boolean> {
  return inside(box, path) && inside(box, await realLocation(resolve(path)));
}

async function realLocation(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if (errorCode(error) !== "ENOENT" || parent === path) throw error;
    return join(await realLocation(parent), basename(path));
  }
}

async function writable(box: Sandbox, path: string): Promise<string> {
  if (!(await contained(box, path)))
    throw new Error(`sandbox: refusing to write ${path}, outside ${box.root}`);
  return path;
}

function guardedFiles(box: Sandbox): Files {
  return {
    read: async (path) => ((await contained(box, path)) ? diskFiles.read(path) : null),
    write: async (path, text) => diskFiles.write(await writable(box, path), text),
    rename: async (from, to) =>
      diskFiles.rename(await writable(box, from), await writable(box, to)),
  };
}

function guardedLock(box: Sandbox): Lock {
  return async (path) => diskLock(await writable(box, path));
}

export async function sandboxGit(
  box: Sandbox,
  folder: string,
  args: readonly string[],
): Promise<string | null> {
  if (!(await contained(box, folder))) return null;
  const env = {
    ...sandboxEnv(box),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(box.root),
  };
  return new Promise((done) => {
    execFile("git", ["-C", folder, ...args], { env, maxBuffer: GIT_OUTPUT }, (error, stdout) => {
      done(error ? null : String(stdout));
    });
  });
}

function quote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
