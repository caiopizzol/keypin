import { parse as parseToml } from "smol-toml";
import type { Environment } from "../contracts";
import type { Place } from "../discovery";
import type { KeyEntry, KeysMap } from "../map";
import { isRecord } from "../record";
import { type Found, proposedIn } from "./places";

const ROTATE_EVERY = "90d";
const FILE = "secretspec.toml";

export function tomlToAdd(
  needs: readonly Found[],
  map: KeysMap | null,
  publish: Environment,
  text: string,
): { text: string | null; declares: Environment[]; edits: Map<string, string> } {
  const blocks: string[][] = [];
  const edits = new Map<string, string>();
  const groups = new Map<string, Found[]>();
  for (const found of needs) {
    const group = `${found.need.name} ${proposedIn(found.place, publish)}`;
    groups.set(group, [...(groups.get(group) ?? []), found]);
  }
  const declares = new Set<Environment>();
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
    const at = `${environment}.${id}`;
    if (!key?.environments[environment]) {
      const usedBy = [...new Set(all.flatMap((each) => each.need.usedBy))];
      own.push([`[profiles.${at}]`, `description = ${str(`Used by ${usedBy.join(", ")}`)}`]);
      declares.add(environment);
    }
    const rotates = key?.rotateEvery || rawTool(text, id, environment);
    own.push([
      `[tool.keypin.${at}]`,
      ...(rotates ? [] : [`rotate_every = ${str(ROTATE_EVERY)}`]),
      publishList(found.map((f) => f.place)),
    ]);
    if (key && !appends(text, own)) {
      const edit = inlineEdit(
        text,
        key,
        environment,
        found.map((f) => f.place),
      );
      for (const { place } of found) edits.set(`${name} ${place.id}`, edit);
      continue;
    }
    blocks.push(...own);
  }
  const toml = blocks.map((block) => block.join("\n")).join("\n\n");
  return { text: blocks.length ? `${toml}\n` : null, declares: [...declares], edits };
}

function inlineEdit(
  text: string,
  key: KeyEntry,
  environment: Environment,
  places: readonly Place[],
): string {
  const entries = places.map(entry);
  const list = publishList(places);
  const at = `[tool.keypin.${environment}.${key.name}]`;
  const declare = key.environments[environment]
    ? ""
    : `declare ${key.name} in [profiles.${environment}], and `;
  const raw = rawTool(text, key.name, environment);
  if (isRecord(raw) && Array.isArray(raw.publish))
    return `${sentence(declare)}${declare ? "add" : "Add"} ${entries.join(" and ")} to the publish list of ${at} in ${FILE}`;
  return `${sentence(declare)}${declare ? "set" : "Set"} ${list} in ${at} in ${FILE}`;
}

function entry(place: Place): string {
  return `{ ${place.fields.map(([field, value]) => `${field} = ${str(value)}`).join(", ")} }`;
}

function publishList(places: readonly Place[]): string {
  return `publish = [${places.map(entry).join(", ")}]`;
}

function sentence(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "";
}

function rawTool(text: string, name: string, environment: Environment): unknown {
  const keypin = table(table(parsed(text).tool).keypin);
  return table(keypin[environment])[name];
}

function parsed(text: string): Record<string, unknown> {
  try {
    return parseToml(text);
  } catch {
    return {};
  }
}

function table(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
