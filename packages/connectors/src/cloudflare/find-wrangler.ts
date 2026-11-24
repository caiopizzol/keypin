import { access, constants, readdir } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { WRANGLER_FILES } from "./wrangler";

export interface InstallAdvice {
  readonly install: string;
  readonly login: string;
}

interface Manager {
  readonly add: string;
  readonly run: string;
}

const NPM: Manager = { add: "npm i -D wrangler", run: "npx wrangler" };
const PNPM: Manager = { add: "pnpm add -D wrangler", run: "pnpm exec wrangler" };
const BUN: Manager = { add: "bun add -d wrangler", run: "bunx wrangler" };

export const INSTALL_IN_PROJECT: InstallAdvice = {
  install: `in the project (${NPM.add})`,
  login: `${NPM.run} login`,
};

const LOCKFILES: readonly (readonly [string, Manager])[] = [
  ["pnpm-lock.yaml", PNPM],
  ["yarn.lock", { add: "yarn add -D wrangler", run: "yarn wrangler" }],
  ["bun.lock", BUN],
  ["bun.lockb", BUN],
  ["package-lock.json", NPM],
];

export async function configFolders(folder: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && WRANGLER_FILES.includes(entry.name)))
      found.push(dir);
    for (const name of await folders(dir)) await visit(join(dir, name));
  };
  await visit(folder);
  return found;
}

export async function wranglers(
  folder: string,
  path: string,
  configs: readonly string[],
): Promise<string[]> {
  const candidates = [
    ...configs.flatMap((config) => upward(config, folder)),
    ...upward(folder, null),
    ...path
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => resolve(dir, "wrangler")),
    ...(await workspaces(folder)).map((dir) => join(dir, "node_modules", ".bin", "wrangler")),
  ];
  const found: string[] = [];
  for (const candidate of new Set(candidates))
    if (await executable(candidate)) found.push(candidate);
  return found;
}

export async function findWrangler(folder: string, path: string): Promise<string | null> {
  return (await wranglers(folder, path, await configFolders(folder)))[0] ?? null;
}

export async function installAdvice(
  folder: string,
  configs: readonly string[],
): Promise<InstallAdvice> {
  let at = shared(configs) ?? folder;
  while (at !== folder && !(await exists(join(at, "package.json")))) at = dirname(at);
  const manager = await lockfileManager(at);
  const workspace = manager === PNPM && (await exists(join(at, "pnpm-workspace.yaml")));
  const where = at === folder ? null : relative(folder, at);
  return {
    install: `in ${where ?? "the project"} (${workspace ? "pnpm add -D -w wrangler" : manager.add})`,
    login: `${where === null ? "" : `cd ${where} && `}${manager.run} login`,
  };
}

async function lockfileManager(from: string): Promise<Manager> {
  for (let dir = from; ; dir = dirname(dir)) {
    for (const [lockfile, manager] of LOCKFILES)
      if (await exists(join(dir, lockfile))) return manager;
    if (dirname(dir) === dir) return NPM;
  }
}

async function workspaces(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const group of await folders(folder)) {
    found.push(join(folder, group));
    for (const member of await folders(join(folder, group)))
      found.push(join(folder, group, member));
  }
  return found;
}

async function folders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function upward(from: string, to: string | null): string[] {
  const found: string[] = [];
  for (let dir = from; ; dir = dirname(dir)) {
    found.push(join(dir, "node_modules", ".bin", "wrangler"));
    if (dir === to || dirname(dir) === dir) return found;
  }
}

function shared(folders: readonly string[]): string | null {
  const [first, ...rest] = folders.map((folder) => folder.split(sep));
  if (!first) return null;
  let length = first.length;
  for (const parts of rest) {
    let same = 0;
    while (same < length && parts[same] === first[same]) same++;
    length = same;
  }
  return first.slice(0, length).join(sep) || sep;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}
