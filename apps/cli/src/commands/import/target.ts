import { join } from "node:path";
import {
  DEFAULT_ENVIRONMENTS,
  type Environment,
  formatReference,
  isEnvironmentName,
  type KeysMap,
  parseMap,
  runEnvironment,
  type VaultKinds,
} from "@keypin/core";
import { type Deps, UsageError } from "../../deps";
import { MAP_FILE } from "../../project";
import { TEMPLATE } from "../init";
import { type Request } from "./request";
import { type Import, type Entry, refFor } from "./plan";

const ROTATE_EVERY = "90d";

interface Target {
  file: string;
  found: string | null;
  map: KeysMap | null;
  account: string;
  vaults: VaultKinds;
}

export function chosenEnvironment(
  requested: string | undefined,
  environments: readonly Environment[],
  runs: Environment,
  target: Target,
): Environment {
  if (requested === undefined || environments.includes(requested)) return requested ?? runs;
  if (!isEnvironmentName(requested))
    throw new UsageError(
      `--env is an environment name: a lowercase letter, then lowercase letters, digits and dashes`,
    );
  const last = environments.at(-1);
  const listed =
    environments.length > 1 && last !== undefined
      ? [...environments.slice(0, -1), requested, last]
      : [...environments, requested];
  const known = environments.map((name) => `"${name}"`).join(", ");
  const line = `environments = [${listed.map(str).join(", ")}]`;
  throw new UsageError(
    `--env ${requested} isn't ${target.map ? `one of ${target.file}'s environments` : "a default environment"} (${known}). To add it, ${target.found === null ? `create ${target.file} with the line ${line}` : `put ${line} at the top of ${target.file}`}`,
  );
}

export async function readTarget(deps: Deps, request: Request): Promise<Target> {
  const file = join(deps.cwd, MAP_FILE);
  const found = await deps.files.read(file);
  if (found === null || found === TEMPLATE) {
    if (!request.account)
      throw new UsageError(
        `--account is required: ${file} doesn't name a 1Password account yet, so give its sign-in address, such as my.1password.com`,
      );
    return { file, found, map: null, account: request.account, vaults: deps.vaults };
  }
  const parsed = parseMap(found, file, deps.destinations, deps.issuers, deps.vaults, deps.pulls);
  if (!parsed.ok) throw new Error(`fix ${file} first: ${parsed.errors.join("; ")}`);
  const pinned = parsed.map.pins["1password"];
  const account = typeof pinned === "string" ? pinned : request.account;
  const other = deps.vaults.find(
    (vault) => !vault.newKeys && parsed.map.pins[vault.kind] !== undefined,
  );
  if (pinned === undefined && other)
    throw new Error(
      `import creates 1Password items, and ${file} reads from ${other.name}; ${other.addByHand?.(parsed.map) ?? `add the secrets in ${other.name} and map them with ${other.scheme} references`}`,
    );
  if (!account)
    throw new UsageError(
      `--account is required: ${file} has no [1password] account, so give its sign-in address, such as my.1password.com`,
    );
  if (request.account && request.account !== account)
    throw new UsageError(
      `${file} uses 1Password account ${account}, not ${request.account}; drop --account`,
    );
  return { file, found, map: parsed.map, account, vaults: deps.vaults };
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
  return parseMap(
    mapText(target, [entry], environment),
    target.file,
    deps.destinations,
    deps.issuers,
    deps.vaults,
    deps.pulls,
  ).ok;
}

function keyTables(target: Target, imports: readonly Entry[], environment: string): string {
  const runs = runEnvironment(target.map ?? { environments: DEFAULT_ENVIRONMENTS });
  return imports
    .map(({ name, ref, existing }) => {
      const key = `\n[keys.${name}]\nrotate_every = ${str(ROTATE_EVERY)}\n`;
      const from = str(formatReference(ref, target.vaults));
      if (!existing && environment === runs) return `${key}${environment} = ${from}\n`;
      return `${existing ? "" : key}\n[keys.${name}.${environment}]\nfrom = ${from}\n`;
    })
    .join("");
}

function mapBase(target: Target): string {
  if (!target.map || target.found === null) return "";
  return target.found.endsWith("\n") || !target.found ? target.found : `${target.found}\n`;
}

export function mapAddition(
  target: Target,
  imports: readonly Entry[],
  environment: string,
): string {
  const account = `[1password]\naccount = ${str(target.account)}\n`;
  const tables = keyTables(target, imports, environment);
  if (!target.map)
    return `# Written by keypin import. The values are in 1Password; this file holds only references.\n\n${account}${tables}`;
  return `${target.map.pins["1password"] ? "" : `\n${account}`}${tables}`;
}

export function mapText(target: Target, imports: readonly Entry[], environment: string): string {
  return `${mapBase(target)}${mapAddition(target, imports, environment)}`;
}

export async function writeMap(
  deps: Deps,
  target: Target,
  imports: readonly Import[],
  environment: string,
): Promise<void> {
  const text = mapText(target, imports, environment);
  const check = parseMap(
    text,
    target.file,
    deps.destinations,
    deps.issuers,
    deps.vaults,
    deps.pulls,
  );
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
