import { parse as parseToml } from "smol-toml";
import type { Environment } from "../contracts";
import type { Place } from "../discovery";
import type { NewKeys, VaultKind, VaultKinds } from "../login";
import type { KeyEntry, KeysMap } from "../map";
import { isRecord } from "../record";
import { formatReference } from "../reference";
import { type Found, proposedIn } from "./places";

const ROTATE_EVERY = "90d";

interface Creates {
  readonly vault: string;
  readonly from: string;
  readonly pin: readonly string[];
  readonly options: string;
  readonly pinOptions: string;
  pinned(map: KeysMap | null): boolean;
}

export function creating(vault: VaultKind, keys: NewKeys): Creates {
  const pin = Object.entries(keys.pin);
  return {
    vault: vault.name,
    from: `${vault.scheme}${keys.reference}`,
    pin: [`[${vault.kind}]`, ...pin.map(([field, value]) => `${field} = ${str(value)}`)],
    options: keys.options,
    pinOptions: pin.map(([field, value]) => ` --${field} ${value}`).join(""),
    pinned: (map) => Boolean(map?.pins[vault.kind]),
  };
}

export function hasEnvironments(text: string): boolean {
  try {
    return parseToml(text).environments !== undefined;
  } catch {
    return false;
  }
}

export function tomlToAdd(
  needs: readonly Found[],
  map: KeysMap | null,
  publish: Environment,
  text: string,
  newKeys: Creates,
  vaults: VaultKinds,
): { text: string | null; pinned: boolean; edits: Map<string, string> } {
  const blocks: string[][] = [];
  const edits = new Map<string, string>();
  const groups = new Map<string, Found[]>();
  for (const found of needs) {
    const group = `${found.need.name} ${proposedIn(found.place, publish)}`;
    groups.set(group, [...(groups.get(group) ?? []), found]);
  }
  const started = new Set<string>();
  for (const all of groups.values()) {
    const name = all[0]?.need.name ?? "";
    const environment = all[0] ? proposedIn(all[0].place, publish) : publish;
    const key = all[0]?.key ?? null;
    const id = key?.name ?? name;
    const claimed = new Map<string, string>();
    for (const target of key?.environments[environment]?.publish ?? [])
      for (const { place } of all) {
        const slot = place.slot?.of(target);
        if (slot) claimed.set(`${target.to}:${slot.name}`, slot.detail);
      }
    const found = all.filter(({ place }) => {
      const slot = place.slot;
      if (!slot) return true;
      const taken = claimed.get(`${place.to}:${slot.name}`);
      if (taken === undefined) {
        claimed.set(`${place.to}:${slot.name}`, slot.detail);
        return true;
      }
      edits.set(`${name} ${place.id}`, slot.twice(id, taken));
      return false;
    });
    if (!found.length) continue;
    const own: string[][] = [];
    if (!key && !started.has(id)) own.push([`[keys.${id}]`, `rotate_every = ${str(ROTATE_EVERY)}`]);
    started.add(id);
    if (!key?.environments[environment])
      own.push([`[keys.${id}.${environment}]`, `from = ${str(newKeys.from)}`]);
    for (const { place } of found)
      own.push([
        `[[keys.${id}.${environment}.publish]]`,
        ...place.fields.map(([field, value]) => `${field} = ${str(value)}`),
      ]);
    if (key && !appends(text, own)) {
      const edit = inlineEdit(
        text,
        key,
        environment,
        found.map((f) => f.place),
        newKeys,
        vaults,
      );
      for (const { place } of found) edits.set(`${name} ${place.id}`, edit);
      continue;
    }
    blocks.push(...own);
  }
  if (!blocks.length) return { text: null, pinned: false, edits };
  const pinned =
    blocks.some((block) => block.includes(`from = ${str(newKeys.from)}`)) && !newKeys.pinned(map);
  if (pinned) blocks.unshift([...newKeys.pin]);
  return { text: `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`, pinned, edits };
}

function inlineEdit(
  text: string,
  key: KeyEntry,
  environment: Environment,
  places: readonly Place[],
  newKeys: Creates,
  vaults: VaultKinds,
): string {
  const entries = places.map(
    (place) => `{ ${place.fields.map(([field, value]) => `${field} = ${str(value)}`).join(", ")} }`,
  );
  const list = `publish = [${entries.join(", ")}]`;
  const entry = key.environments[environment];
  const at = `[keys.${key.name}]`;
  if (!entry)
    return `Add ${environment} = { from = ${str(newKeys.from)}, ${list} } to ${at} in keypin.toml`;
  const from = `from = ${str(formatReference(entry.ref, vaults))}`;
  const raw = rawEntry(text, key.name, environment);
  if (typeof raw === "string")
    return `In ${at} in keypin.toml, replace ${environment} = ${str(raw)} with ${environment} = { ${from}, ${list} }`;
  if (isRecord(raw) && Array.isArray(raw.publish))
    return `Add ${entries.join(" and ")} to the publish list of ${environment} in ${at} in keypin.toml`;
  return `In ${at} in keypin.toml, replace the ${environment} entry with ${environment} = { ${from}, ${list} }`;
}

function rawEntry(text: string, name: string, environment: Environment): unknown {
  try {
    const data = parseToml(text);
    const key = isRecord(data.keys) ? data.keys[name] : undefined;
    return isRecord(key) ? key[environment] : undefined;
  } catch {
    return undefined;
  }
}

function appends(text: string, blocks: readonly string[][]): boolean {
  try {
    parseToml(`${text}\n${blocks.map((block) => block.join("\n")).join("\n\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

function str(value: string): string {
  return JSON.stringify(value);
}
