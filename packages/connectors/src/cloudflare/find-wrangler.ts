import { access, constants, readdir } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { WRANGLER_FILES } from "./wrangler";

const NPM = "npm i -D wrangler";
const PNPM = "pnpm add -D wrangler";
export const INSTALL_IN_PROJECT = `in the project (${NPM})`;

const LOCKFILES: readonly (readonly [string, string])[] = [
  ["pnpm-lock.yaml", PNPM],
  ["yarn.lock", "yarn add -D wrangler"],
  ["bun.lock", "bun add -d wrangler"],
  ["bun.lockb", "bun add -d wrangler"],
  ["package-lock.json", NPM],
];

export async function configFolders(folder: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && WRANGLER_FILES.includes(entry.name)))
      found.push(dir);
    const folders = entries
      .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    for (const name of folders) await visit(join(dir, name));
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
  ];
  const found: string[] = [];
  for (const candidate of new Set(candidates))
    if (await executable(candidate)) found.push(candidate);
  return found;
}

export async function findWrangler(folder: string, path: string): Promise<string | null> {
  return (await wranglers(folder, path, await configFolders(folder)))[0] ?? null;
}

export async function installAdvice(folder: string, configs: readonly string[]): Promise<string> {
  let at = shared(configs) ?? folder;
  while (at !== folder && !(await exists(join(at, "package.json")))) at = dirname(at);
  const command = await lockfileCommand(at);
  const workspace = command === PNPM && (await exists(join(at, "pnpm-workspace.yaml")));
  return `in ${at === folder ? "the project" : relative(folder, at)} (${workspace ? "pnpm add -D -w wrangler" : command})`;
}

async function lockfileCommand(from: string): Promise<string> {
  for (let dir = from; ; dir = dirname(dir)) {
    for (const [lockfile, command] of LOCKFILES)
      if (await exists(join(dir, lockfile))) return command;
    if (dirname(dir) === dir) return NPM;
  }
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
