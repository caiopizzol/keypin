import { basename, join } from "node:path";
import {
  type Environment,
  isEnvironmentName,
  type KeysMap,
  type MapResult,
  projectDefaults,
  type VaultKinds,
  vaultName,
} from "@keypin/core";
import { type Deps, UsageError } from "../../deps";
import { MAP_FILE, readMap } from "../../project";
import { type Request } from "./request";
import { type Import, type Entry, refFor } from "./plan";

const ROTATE_EVERY = "90d";

interface Target {
  file: string;
  found: string | null;
  map: KeysMap | null;
  project: string;
  account: string;
  vaults: VaultKinds;
}

export function chosenEnvironment(
  requested: string | undefined,
  environments: readonly Environment[],
  runs: Environment,
): Environment {
  if (requested === undefined || environments.includes(requested)) return requested ?? runs;
  if (!isEnvironmentName(requested))
    throw new UsageError(
      `--profile is a profile name: a lowercase letter, then lowercase letters, digits and dashes`,
    );
  return requested;
}

export async function readTarget(deps: Deps, request: Request): Promise<Target> {
  const file = join(deps.cwd, MAP_FILE);
  const found = await deps.files.read(file);
  const project = basename(deps.cwd);
  const own = { file, found, project, vaults: deps.vaults };
  if (found === null) {
    if (!request.account)
      throw new UsageError(
        `--account is required: there's no ${file} yet, so give the 1Password account's sign-in address, such as my.1password.com`,
      );
    return { ...own, map: null, account: request.account };
  }
  const parsed = readMap(deps, { file, text: found });
  if (!parsed.ok) throw new Error(`fix ${file} first: ${parsed.errors.join("; ")}`);
  const refs = parsed.map.keys.flatMap((key) =>
    Object.values(key.environments).flatMap((entry) => (entry ? [entry.ref] : [])),
  );
  const creates = deps.vaults.find((vault) => vault.newKeys);
  const { uri } = projectDefaults(found);
  const probe = { project: parsed.map.project, profile: "default", key: "KEY", ref: null };
  const located = uri === null ? undefined : creates?.secretspec?.locate?.({ uri, ...probe });
  const placed = typeof located === "object" ? [located] : [];
  const mine = [...refs, ...placed].find((ref) => ref.kind === creates?.kind);
  const other = refs.find((ref) => ref.kind !== creates?.kind);
  if (!mine && other)
    throw new Error(
      `import creates 1Password items, and ${file} reads from ${vaultName(other, deps.vaults)}`,
    );
  const pinned = typeof mine?.account === "string" ? mine.account : undefined;
  const account = pinned ?? request.account;
  if (!account)
    throw new UsageError(
      `--account is required: ${file} reads no 1Password account yet, so give its sign-in address, such as my.1password.com`,
    );
  if (request.account && request.account !== account)
    throw new UsageError(
      `${file} uses 1Password account ${account}, not ${request.account}; drop --account`,
    );
  return { ...own, project: parsed.map.project, map: parsed.map, account };
}

export function extendsKey(
  deps: Deps,
  target: Target,
  {
    name,
    vault,
    item,
    environment,
  }: { name: string; vault: string; item: string; environment: string },
): boolean {
  const entry: Entry = { name, ref: refFor(target.account, vault, item), existing: true };
  return parse(deps, target, mapText(target, [entry], environment)).ok;
}

function keyTables(target: Target, imports: readonly Entry[], environment: string): string {
  const defaults = projectDefaults(target.found ?? "");
  const [first] = imports;
  const uri = first ? providerOf(first) : null;
  const addsDefault = !defaults.declared && uri !== null;
  const tables = imports
    .map((entry) => {
      const { name, ref, existing } = entry;
      const own = providerOf(entry);
      const providers =
        own === defaults.uri || (addsDefault && own === uri) ? "" : `providers = [${str(own)}]\n`;
      const declared = `\n[profiles.${environment}.${name}]\ndescription = ${str(name)}\n${providers}ref = { item = ${str(ref.item)}, field = ${str(ref.field)} }\n`;
      const tool = `\n[tool.keypin.${environment}.${name}]\nrotate_every = ${str(ROTATE_EVERY)}\n`;
      return existing ? declared : `${declared}${tool}`;
    })
    .join("");
  return addsDefault ? `\n[defaults]\nproviders = [${str(uri)}]\n${tables}` : tables;
}

function providerOf({ ref }: Entry): string {
  return `onepassword://${ref.account}@${ref.vault}`;
}

function mapBase(target: Target): string {
  if (target.found === null) return "";
  return target.found.endsWith("\n") || !target.found ? target.found : `${target.found}\n`;
}

export function mapAddition(
  target: Target,
  imports: readonly Entry[],
  environment: string,
): string {
  const tables = keyTables(target, imports, environment);
  if (target.found !== null) return tables;
  const project = `[project]\nname = ${str(target.project)}\nrevision = "1.0"\n`;
  return `# Written by keypin import. The values are in 1Password; this file holds only names and places.\n\n${project}${tables}`;
}

export function mapText(target: Target, imports: readonly Entry[], environment: string): string {
  return `${mapBase(target)}${mapAddition(target, imports, environment)}`;
}

export function parse(deps: Deps, target: Target, text: string): MapResult {
  return readMap(deps, { file: target.file, text });
}

export async function writeMap(
  deps: Deps,
  target: Target,
  imports: readonly Import[],
  environment: string,
): Promise<void> {
  const text = mapText(target, imports, environment);
  const check = parse(deps, target, text);
  if (!check.ok)
    throw new Error(`the new ${target.file} doesn't parse: ${check.errors.join("; ")}`);
  const result =
    target.found === null
      ? await deps.createFile(target.file, text)
      : await deps.replaceFile(target.file, target.found, text);
  if (result === "link")
    throw new Error(`${target.file} is a symbolic link; keypin import doesn't follow one`);
  if (result === "exists" || result === "changed")
    throw new Error(`${target.file} changed while import ran, so it wasn't written`);
}

function str(value: string): string {
  return JSON.stringify(value);
}
