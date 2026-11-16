import { parse as parseToml } from "smol-toml";
import type { Environment } from "./contracts";
import { DEFAULT_ENVIRONMENTS } from "./contracts";
import type { PublishTarget } from "./destination";
import type { Discovered, Needs, Place } from "./discovery";
import type { NewKeys, VaultKind, VaultKinds } from "./login";
import {
  envFlag,
  isEnvironmentName,
  isVariableName,
  type KeyEntry,
  type KeysMap,
  publishEnvironment,
  runEnvironment,
} from "./map";
import { isRecord } from "./record";
import { formatReference } from "./reference";
import { type EnvFileKind, envFileSuffix } from "./dotenv";

export interface ProjectScan {
  envFiles: { path: string; kind: EnvFileKind; names: string[]; tracked: boolean | null }[];
  discovered: readonly Discovered[];
}

export interface Need {
  name: string;
  to: PublishTarget["to"];
  place: string;
  usedBy: string[];
  mapped: Environment | null;
  holds: boolean | null;
  ok: boolean;
}

export interface LocalFile {
  file: string;
  tracked: boolean | null;
  unmapped: string[];
  elsewhere: string[];
}

export type Fix =
  | { kind: "environments"; text: string; why: string; at: string; line: string }
  | { kind: "tracked"; text: string; file: string }
  | {
      kind: "import";
      text: string;
      why: string;
      vault: string;
      file: string;
      names: string[];
      options: string;
      caveat: string | null;
    }
  | { kind: "add"; text: string; why: string; key: string }
  | { kind: "edit"; text: string }
  | { kind: "publish"; text: string; key: string; why: string; command: string };

export interface Gaps {
  production: Need[];
  local: LocalFile[];
  add: string | null;
  addsPin: boolean;
  problems: string[];
  notes: string[];
  fixes: Fix[];
}

const ROTATE_EVERY = "90d";

interface Creates {
  readonly vault: string;
  readonly from: string;
  readonly pin: readonly string[];
  readonly options: string;
  readonly pinOptions: string;
  pinned(map: KeysMap | null): boolean;
}

function creating(vault: VaultKind, keys: NewKeys): Creates {
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

interface Found {
  need: Need;
  place: Place;
  key: KeyEntry | null;
}

export function findGaps(
  scan: ProjectScan,
  map: { map: KeysMap; text: string } | null,
  vaults: VaultKinds,
): Gaps {
  const keys = map?.map ?? null;
  const creates = vaults.find((vault) => vault.newKeys);
  if (!creates?.newKeys) throw new Error("keypin has no vault kind that creates new keys");
  const newKeys = creating(creates, creates.newKeys);
  const listed = keys?.environments ?? DEFAULT_ENVIRONMENTS;
  const environment = publishEnvironment({ environments: listed });
  const notes: string[] = [];
  const needs: Found[] = [];
  const ignore = keys?.ignore ?? [];
  const ignored = new Set<string>();
  const skipped: { name: string; place: string }[] = [];
  const need = (name: string, place: Place, usedBy: string) => {
    if (!isVariableName(name)) return;
    const skip = ignore.find((each) => place.matches(each, name));
    if (skip !== undefined) {
      ignored.add(skip);
      skipped.push({ name, place: place.id });
      return;
    }
    const found = needs.find((n) => n.need.name === name && n.place.id === place.id);
    if (found) {
      if (!found.need.usedBy.includes(usedBy)) found.need.usedBy.push(usedBy);
      return;
    }
    needs.push(resolve(name, place, [usedBy]));
  };
  const resolve = (name: string, place: Place, usedBy: string[]): Found => {
    const candidates = (keys?.keys ?? []).filter((k) => place.matches(k.name, name));
    const key =
      candidates.find((k) => mappedIn(keys, k, place) !== null) ??
      candidates.find((k) => k.name === name) ??
      candidates[0] ??
      null;
    const mapped = mappedIn(keys, key, place);
    const holds = place.holds(name);
    return {
      place,
      key,
      need: {
        name,
        to: place.to,
        place: place.label,
        usedBy,
        mapped,
        holds,
        ok: mapped !== null && holds !== false,
      },
    };
  };

  const view = {
    publishEnvironment: environment,
    publishes: (name: string, place: Place) =>
      (keys?.keys ?? []).some(
        (k) => place.matches(k.name, name) && mappedIn(keys, k, place) !== null,
      ),
  };
  const after: NonNullable<Needs["notesAfter"]>[] = [];
  const conflicts: string[] = [];
  for (const discovered of scan.discovered) {
    const found = discovered.needs(view);
    for (const { name, place, usedBy } of found.needs) need(name, place, usedBy);
    notes.push(...found.notes);
    conflicts.push(...(found.problems ?? []));
    if (found.notesAfter) after.push(found.notesAfter);
  }

  const elsewhere = (found: Found) =>
    found.place.onlyFrom ? mappedIn(keys, found.key, found.place, []) : null;
  const missing = needs.filter((n) => n.need.mapped === null && elsewhere(n) === null);
  const add = tomlToAdd(missing, keys, environment, map?.text ?? "", newKeys, vaults);

  const problems: string[] = [...conflicts];
  const fixes: Fix[] = [];
  const fix = (found: Fix) => {
    fixes.push(found);
    problems.push(found.text);
  };
  const outside = needs.filter(
    ({ need: n, place }) => n.mapped === null && !listed.includes(proposedIn(place, environment)),
  );
  const unlisted = [...new Set(outside.map(({ place }) => proposedIn(place, environment)))];
  const source = outside[0]?.place.onlyFrom?.source;
  if (unlisted.length && source !== undefined) {
    const order =
      listed.length > 1
        ? [...listed.slice(0, -1), ...unlisted, environment]
        : [...listed, ...unlisted];
    const line = `environments = ${JSON.stringify(order).replaceAll(",", ", ")}`;
    const at = hasEnvironments(map?.text ?? "")
      ? "replace the environments line in keypin.toml with"
      : "add at the top of keypin.toml";
    const why = `keypin.toml has no environment for the ${source}${unlisted.length > 1 ? "s" : ""} ${unlisted.join(" and ")}`;
    fix({
      kind: "environments",
      text: `${why}; ${at}: ${line} (keypin run uses the first, keypin publish the last)`,
      why,
      at,
      line,
    });
  }
  for (const found of needs) {
    const { need: n, place, key } = found;
    if (n.ok) continue;
    const uses = `${n.usedBy.join(", ")} ${place.verb} it`;
    const other = elsewhere(found);
    const only = place.onlyFrom;
    if (other !== null && only && n.mapped === null) {
      const why = `${n.name}: ${uses}`;
      const edit = `keypin.toml publishes it to ${place.label} from ${other}, but that ${only.thing} is the ${only.source} ${only.environments.join(" and ")}, so it would get the ${other} value; move that publish entry to ${only.environments.join(" or ")}`;
      fix({ kind: "edit", text: `${why}; ${edit}` });
      continue;
    }
    if (n.mapped !== null) {
      const why = `${n.name}: keypin.toml publishes it to ${place.label}, which doesn't have it yet`;
      const name = key?.name ?? n.name;
      const command = `keypin publish ${name}${envFlag(n.mapped, environment)}`;
      fix({ kind: "publish", text: `${why}; run ${command}`, key: name, why, command });
      continue;
    }
    const held =
      n.holds === true
        ? `${place.label} has it, but keypin.toml doesn't publish it there`
        : n.holds === false
          ? `${place.label} doesn't have it${place.aside?.(n.name) ?? ""}, and keypin.toml doesn't publish it there`
          : `keypin.toml doesn't publish it to ${place.label}`;
    const why = `${n.name}: ${uses}; ${held}`;
    const edit = add.edits.get(`${n.name} ${place.id}`);
    fix(
      edit === undefined
        ? { kind: "add", text: `${why}. Add the TOML below`, why, key: key?.name ?? n.name }
        : { kind: "edit", text: `${why}. ${edit}` },
    );
  }
  const resolved = [...needs.map((n) => ({ name: n.need.name, place: n.place.id })), ...skipped];
  for (const notesAfter of after) notes.push(...notesAfter(resolved));

  const environments = keys?.environments ?? DEFAULT_ENVIRONMENTS;
  const run = runEnvironment({ environments });
  const byHand = keys
    ? vaults.map((vault) => vault.addByHand?.(keys)).find((text) => text !== undefined)
    : undefined;
  const local: LocalFile[] = [];
  for (const file of scan.envFiles) {
    if (file.kind !== "set") continue;
    const suffix = envFileSuffix(file.path.split("/").at(-1) ?? "");
    const env = suffix !== undefined && environments.includes(suffix) ? suffix : run;
    const flag = envFlag(env, run);
    const caveat =
      suffix !== undefined &&
      !environments.includes(suffix) &&
      isEnvironmentName(suffix) &&
      !/^(local|dev|development)$/.test(suffix)
        ? `maps them as ${run}; if they're the values of another environment, list it in environments and add --env <name>`
        : null;
    const other = caveat === null ? "" : `, which ${caveat}`;
    const names = file.names.filter(isVariableName);
    const key = (name: string) => keys?.keys.find((k) => k.name === name);
    const unmapped = names.filter((name) => {
      if (!ignore.includes(name)) return !key(name);
      ignored.add(name);
      return false;
    });
    const elsewhere = names.filter((name) => {
      const found = key(name);
      return found !== undefined && !found.environments[env];
    });
    local.push({ file: file.path, tracked: file.tracked, unmapped, elsewhere });
    if (file.tracked)
      fix({
        kind: "tracked",
        text: `${file.path} is tracked by git, so its values may be committed`,
        file: file.path,
      });
    const importing = (why: string, names: string[], account: string) => ({
      kind: "import" as const,
      why,
      vault: newKeys.vault,
      file: file.path,
      names,
      options: `${flag} ${newKeys.options}${account}`,
      caveat: caveat && `That command ${caveat}`,
    });
    if (unmapped.length && byHand !== undefined) {
      const sets = `${file.path} sets ${unmapped.join(", ")}, which keypin.toml doesn't map`;
      notes.push(`${sets}; a plain setting can stay, and for a key ${byHand}`);
    } else if (unmapped.length) {
      const account = newKeys.pinned(keys) ? "" : newKeys.pinOptions;
      const sets = `${file.path} sets ${unmapped.join(", ")}, which keypin.toml doesn't map`;
      const found = importing(sets, unmapped, account);
      const text = `${sets}; a plain setting can stay, and for a key run keypin import ${file.path} NAME...${found.options}${other}`;
      notes.push(text);
      fixes.push({ ...found, text });
    }
    if (elsewhere.length && byHand !== undefined) {
      const why = `${file.path} sets ${elsewhere.join(", ")}, which keypin.toml maps with no ${env} entry`;
      fix({ kind: "edit", text: `${why}; for a key ${byHand}` });
    } else if (elsewhere.length) {
      const why = `${file.path} sets ${elsewhere.join(", ")}, which keypin.toml maps with no ${env} entry`;
      const found = importing(why, elsewhere, "");
      fix({
        ...found,
        text: `${why}; for a key run keypin import ${file.path} ${elsewhere.join(" ")}${found.options}${other}`,
      });
    }
  }

  if (ignored.size)
    notes.push(`${ignored.size} ${ignored.size === 1 ? "key" : "keys"} ignored in keypin.toml`);

  return {
    production: needs.map((n) => n.need),
    local,
    add: add.text,
    addsPin: add.pinned,
    problems,
    notes,
    fixes,
  };
}

function mappedIn(
  map: KeysMap | null,
  key: KeyEntry | null,
  place: Place,
  only: readonly Environment[] = place.onlyFrom?.environments ?? [],
): Environment | null {
  if (!key) return null;
  for (const environment of map?.environments ?? []) {
    if (only.length && !only.includes(environment)) continue;
    if (key.environments[environment]?.publish.some((target) => place.covers(target)))
      return environment;
  }
  return null;
}

function proposedIn(place: Place, publish: Environment): Environment {
  const only = place.onlyFrom?.environments ?? [];
  return only.length && !only.includes(publish) ? (only[0] ?? publish) : publish;
}

function hasEnvironments(text: string): boolean {
  try {
    return parseToml(text).environments !== undefined;
  } catch {
    return false;
  }
}

function tomlToAdd(
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
