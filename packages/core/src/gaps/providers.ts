import { parse as parseToml } from "smol-toml";
import type { Environment } from "../contracts";
import type { VaultKinds } from "../login";
import { isRecord } from "../record";

const DEFAULT = "default";

type Table = Record<string, unknown>;

export interface ProviderLines {
  readonly toml: string;
  readonly existing: readonly string[];
}

export function providerLines(
  text: string,
  profiles: readonly Environment[],
  vaults: VaultKinds,
): ProviderLines | null {
  const data = parsed(text);
  if (data === null) return null;
  const creates = vaults.find((vault) => vault.newKeys && vault.secretspec);
  if (!creates?.newKeys || !creates.secretspec) return null;
  const uri = creates.newKeys.provider;
  const named = table(data.providers);
  const defined = Object.keys(named);
  const all = table(data.profiles);
  const base = table(all[DEFAULT]);
  const chainOf = (profile: string, secret: unknown): string[] =>
    list(table(secret).providers) ??
    list(table(table(all[profile]).defaults).providers) ??
    list(table(data.defaults).providers) ??
    [];

  const used: string[] = [];
  let unpinned = false;
  for (const [profile, raw] of Object.entries(all)) {
    const own = table(raw);
    const inherits = profile !== DEFAULT && table(own.defaults).inherit !== false;
    const names = new Set([...(inherits ? Object.keys(base) : []), ...Object.keys(own)]);
    names.delete("defaults");
    for (const name of names) {
      const secret = { ...(inherits ? table(base[name]) : {}), ...table(own[name]) };
      if (secret.composed !== undefined || secret.from !== undefined) continue;
      const [first] = chainOf(profile, secret);
      if (first === undefined) unpinned = true;
      else used.push(first);
    }
  }
  for (const profile of profiles) if (chainOf(profile, {})[0] === undefined) unpinned = true;

  const missing = [...new Set(used)].filter((alias) => !alias.includes("://") && !named[alias]);
  const alias = defined[0] ?? missing[0] ?? creates.secretspec.provider;
  const entries = missing.map((name) => `${name} = ${JSON.stringify(uri)}`);
  if (unpinned && !defined.length && !missing.length)
    entries.push(`${alias} = ${JSON.stringify(uri)}`);
  const blocks: string[][] = [];
  const existing: string[] = [];
  if (entries.length) {
    blocks.push(["[providers]", ...entries]);
    if (isRecord(data.providers)) existing.push("[providers]");
  }
  if (unpinned) {
    blocks.push(["[defaults]", `providers = [${JSON.stringify(alias)}]`]);
    if (isRecord(data.defaults)) existing.push("[defaults]");
  }
  if (!blocks.length) return null;
  return { toml: `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`, existing };
}

function parsed(text: string): Table | null {
  try {
    return parseToml(text);
  } catch {
    return null;
  }
}

function table(value: unknown): Table {
  return isRecord(value) ? value : {};
}

function list(value: unknown): string[] | null {
  return Array.isArray(value) && value.length && value.every((each) => typeof each === "string")
    ? value
    : null;
}
