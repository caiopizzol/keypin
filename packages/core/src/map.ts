import { parse as parseToml, TomlError } from "smol-toml";
import type { Environment, KeyId, KeyRef } from "./contracts";
import { DEFAULT_ENVIRONMENTS } from "./contracts";
import {
  type DestinationKinds,
  placeId,
  type PublishTarget,
  secretKey,
  type TableReader,
} from "./destination";
import type { IssuerKinds, IssuerReader, IssuerSpec } from "./issuer";
import type { VaultKinds } from "./login";
import { isRecord } from "./record";
import { byKind, parseReference, referenceSchemes, sameItem } from "./reference";
import { periodDays } from "./days";

export interface EnvEntry {
  ref: KeyRef;
  publish: PublishTarget[];
  issuer?: IssuerSpec;
}

export interface KeyEntry {
  name: KeyId;
  rotateEvery: string | null;
  environments: Partial<Record<Environment, EnvEntry>>;
}

export type VaultPins = Readonly<Record<string, unknown>>;

export interface KeysMap {
  file: string;
  pins: VaultPins;
  environments: readonly Environment[];
  keys: KeyEntry[];
}

export type MapResult = { ok: true; map: KeysMap } | { ok: false; errors: string[] };

export function runEnvironment(map: Pick<KeysMap, "environments">): Environment {
  return map.environments[0] ?? "dev";
}

export function publishEnvironment(map: Pick<KeysMap, "environments">): Environment {
  return map.environments.at(-1) ?? "prod";
}

export function envFlag(environment: Environment, fallback: Environment): string {
  return environment === fallback ? "" : ` --env ${environment}`;
}

export function isEnvironmentName(name: string): boolean {
  return ENVIRONMENT_NAME.test(name);
}

export function isVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name);
}

export function parseMap(
  text: string,
  file: string,
  kinds: DestinationKinds,
  issuers: IssuerKinds,
  vaults: VaultKinds,
): MapResult {
  let data: unknown;
  try {
    data = parseToml(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`${file}: not valid TOML: ${tomlProblem(error)}`],
    };
  }
  return validateMap(data, file, { kinds, issuers, vaults });
}

type Table = Record<string, unknown>;

const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]*$/;
const KEY_FIELDS: readonly string[] = ["rotate_every"];
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REMOVED_KEY_FIELDS: readonly string[] = ["owner", "consumers"];
const OLD_FORMAT = "see docs/configuration.md for the current format";
const PLACEHOLDER = /<[^<>]*>/;

function filledIn(
  value: string | undefined,
  field: string,
  what: string,
  fail: (message: string) => void,
): string | undefined {
  if (value === undefined || !PLACEHOLDER.test(value)) return value;
  fail(`field "${field}" is a <...> placeholder: replace it with ${what}`);
  return undefined;
}

function validateMap(
  data: unknown,
  file: string,
  { kinds, issuers, vaults }: Pick<MapContext, "kinds" | "issuers" | "vaults">,
): MapResult {
  const errors: string[] = [];
  const fail = (where: string, message: string) => errors.push(`${file}: ${where}${message}`);

  if (!isRecord(data)) return { ok: false, errors: [`${file}: expected a table at the top level`] };
  unknownFields(data, ["environments", ...vaults.map((v) => v.kind), "keys"], (field) =>
    fail(
      "",
      field === "vaults"
        ? `[vaults] is from keypin 0.4; use [1password] and op:// references (${OLD_FORMAT})`
        : field === "targets"
          ? `shared [targets] are no longer supported; write each destination inline under [[keys.<VARIABLE>.<env>.publish]] (${OLD_FORMAT})`
          : `unknown top-level field "${field}"`,
    ),
  );
  const environments = validateEnvironments(data.environments, (message) => fail("", message));
  const pins = validatePins(data, vaults, fail);

  const keys: KeyEntry[] = [];
  const rawKeys = data.keys ?? {};
  if (!isRecord(rawKeys)) fail("", `"keys" must be a table`);
  else {
    Object.entries(rawKeys).forEach(([id, raw], index) => {
      const label = VARIABLE_NAME.test(id) ? `key "${id}"` : `keys[${index}]`;
      const context = { pins, environments, kinds, issuers, vaults };
      const entry = validateKey(id, raw, context, (where, message) =>
        fail(`${label}${where}: `, message),
      );
      if (entry) keys.push(entry);
    });
  }

  sharedDestinations(keys, environments, kinds, (where, message) => fail(where, message));
  sharedClaims(keys, environments, issuers, (where, message) => fail(where, message));
  return errors.length
    ? { ok: false, errors }
    : { ok: true, map: { file, pins, environments, keys } };
}

function validatePins(
  data: Table,
  vaults: VaultKinds,
  fail: (where: string, message: string) => void,
): VaultPins {
  const pins: Record<string, unknown> = {};
  for (const vault of byKind(vaults)) {
    const raw = data[vault.kind];
    if (raw === undefined) continue;
    const err = (message: string) => fail(`[${vault.kind}]: `, message);
    if (!isRecord(raw)) {
      err("must be a table");
      continue;
    }
    const pin = vault.readPin({
      ...tableReader(raw, [], vault.kind, err),
      only: (fields) => unknownFields(raw, fields, (field) => err(`unknown field "${field}"`)),
    });
    if (pin !== undefined) pins[vault.kind] = pin;
  }
  return pins;
}

function validateEnvironments(
  raw: unknown,
  fail: (message: string) => void,
): readonly Environment[] {
  if (raw === undefined) return DEFAULT_ENVIRONMENTS;
  if (!Array.isArray(raw) || !raw.length || !raw.every((name) => typeof name === "string")) {
    fail(`"environments" must be a list of names, such as ["dev", "staging", "prod"]`);
    return DEFAULT_ENVIRONMENTS;
  }
  const names: string[] = [];
  for (const name of raw) {
    if (!isEnvironmentName(name)) {
      fail(
        `environment "${name}": a name starts with a lowercase letter and uses only lowercase letters, digits and dashes`,
      );
    } else if (names.includes(name)) {
      fail(`environment "${name}" is listed twice`);
    } else names.push(name);
  }
  return names;
}

function sharedDestinations(
  keys: KeyEntry[],
  environments: readonly Environment[],
  kinds: DestinationKinds,
  fail: (where: string, message: string) => void,
) {
  const owners = new Map<string, string>();
  for (const key of keys) {
    for (const environment of environments) {
      key.environments[environment]?.publish.forEach((target, i) => {
        const where = `key "${key.name}" ${environment} publish[${i}]`;
        const secret = secretKey(target, key.name, kinds);
        const owner = owners.get(secret);
        if (owner === undefined) owners.set(secret, where);
        else fail(`${where}: `, `writes the same destination secret as ${owner}`);
      });
    }
  }
}

function sharedClaims(
  keys: KeyEntry[],
  environments: readonly Environment[],
  issuers: IssuerKinds,
  fail: (where: string, message: string) => void,
) {
  const owners = new Map<string, string>();
  for (const key of keys) {
    for (const environment of environments) {
      const spec = key.environments[environment]?.issuer;
      if (!spec) continue;
      const where = `key "${key.name}" ${environment}`;
      const claims = issuers.find((k) => k.kind === spec.kind)?.claims?.(spec) ?? [];
      const id = (claim: string) => `${spec.kind}:${claim}`;
      const shared = claims.find((claim) => owners.has(id(claim)));
      if (shared !== undefined)
        fail(
          `${where} issuer: `,
          `${owners.get(id(shared))} also rotates ${shared}, so rotating either key breaks the other. Change one issuer so they share nothing, or remove one`,
        );
      for (const claim of claims) if (!owners.has(id(claim))) owners.set(id(claim), where);
    }
  }
}

interface MapContext {
  pins: VaultPins;
  environments: readonly Environment[];
  kinds: DestinationKinds;
  issuers: IssuerKinds;
  vaults: VaultKinds;
}

function validateKey(
  id: string,
  raw: unknown,
  context: MapContext,
  fail: (where: string, message: string) => void,
): KeyEntry | undefined {
  const environmentNames = context.environments;
  let failures = 0;
  const err = (where: string, message: string) => {
    failures++;
    fail(where, message);
  };
  if (!VARIABLE_NAME.test(id))
    err(
      "",
      "the table name is the variable your program reads: letters, digits and _, not starting with a digit",
    );
  if (!isRecord(raw)) {
    err("", "must be a table");
    return undefined;
  }
  unknownFields(raw, [...KEY_FIELDS, ...environmentNames], (field) =>
    err(
      "",
      field === "env"
        ? `field "env" is from keypin 0.4; name the table after the variable, such as [keys.API_TOKEN] (${OLD_FORMAT})`
        : REMOVED_KEY_FIELDS.includes(field)
          ? `field "${field}" is no longer used; delete it`
          : `unknown field "${field}"; environments are ${environmentNames.map((n) => `"${n}"`).join(", ")}`,
    ),
  );
  const rotateEvery = optionalString(raw, "rotate_every", (m) => err("", m));
  if (rotateEvery !== undefined && periodDays(rotateEvery) === undefined) {
    err("", `field "rotate_every" must be <n>d, <n>w, <n>m or never`);
  }

  const environments: Record<Environment, EnvEntry> = {};
  Reflect.setPrototypeOf(environments, null);
  const declared = environmentNames.filter((name) => Object.hasOwn(raw, name));
  for (const name of declared) {
    const entry = validateEnv(raw[name], context, (m) => err(` ${name}`, m));
    if (entry) environments[name] = entry;
  }
  for (const [name, entry] of Object.entries(environments)) {
    const refused = new Set<string>();
    entry.publish.forEach((target, index) => {
      const why = context.kinds.find((k) => k.kind === target.to)?.refuses?.(id);
      if (why === undefined || refused.has(target.to)) return;
      refused.add(target.to);
      err(` ${name}`, `publish[${index}]: ${target.to} can't take this key, because ${why}`);
    });
  }
  if (!declared.length) {
    err("", `needs at least one of ${environmentNames.map((n) => `"${n}"`).join(", ")}`);
  }

  if (failures) return undefined;
  return { name: id, rotateEvery: rotateEvery ?? null, environments };
}

function validateEnv(
  given: unknown,
  context: MapContext,
  fail: (message: string) => void,
): EnvEntry | undefined {
  const { kinds } = context;
  const raw = typeof given === "string" ? { from: given } : given;
  if (!isRecord(raw)) {
    fail(`must be an ${referenceSchemes(context.vaults)} reference, or a table with "from"`);
    return undefined;
  }
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  unknownFields(raw, ["from", "publish", "issuer"], (field) =>
    err(
      field === "vault" || field === "item"
        ? `"vault" and "item" are from keypin 0.4; use from = "op://<vault>/<item>/<field>" (${OLD_FORMAT})`
        : field === "rotate" || field === "issue"
          ? `the "${field}" section is from an older keypin; delete it. To let keypin rotate the key, add an "issuer" table instead (${OLD_FORMAT})`
          : `unknown field "${field}"`,
    ),
  );
  const ref = reference(raw, "from", context, err);

  const publish: PublishTarget[] = [];
  const firstAt = new Map<string, number>();
  if (raw.publish !== undefined) {
    if (!Array.isArray(raw.publish)) err(`field "publish" must be a list`);
    else {
      raw.publish.forEach((t: unknown, i: number) => {
        const target = destination(t, kinds, (m) => err(`publish[${i}]: ${m}`));
        if (!target) return;
        const place = placeId(target, kinds);
        const same = firstAt.get(place);
        if (same !== undefined) err(`publish[${i}]: the same destination as publish[${same}]`);
        else {
          firstAt.set(place, i);
          publish.push(target);
        }
      });
    }
  }
  const issuer =
    raw.issuer === undefined || !ref
      ? undefined
      : validateIssuer(raw.issuer, ref, context, (m) => err(`issuer: ${m}`));
  if (failed || !ref) return undefined;
  return issuer ? { ref, publish, issuer } : { ref, publish };
}

function validateIssuer(
  raw: unknown,
  own: KeyRef,
  context: MapContext,
  fail: (message: string) => void,
): IssuerSpec | undefined {
  const { issuers, vaults } = context;
  if (!isRecord(raw)) {
    fail("must be a table");
    return undefined;
  }
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  const kind = requiredString(raw, "kind", err);
  if (kind === undefined) return undefined;
  const found = issuers.find((k) => k.kind === kind);
  if (!found) {
    err(`field "kind" must be one of: ${issuers.map((k) => k.kind).join(", ")}`);
    return undefined;
  }
  const reader: IssuerReader = {
    ...tableReader(raw, ["kind", "admin"], kind, err),
    admin() {
      const admin = reference(raw, "admin", context, err);
      if (!admin || !sameItem(admin, own, vaults)) return admin;
      err(`field "admin" names the key's own item; the admin key needs its own item`);
      return undefined;
    },
  };
  const spec = found.parse(reader);
  if (spec === undefined && !failed) err(`the "${kind}" issuer couldn't read this table`);
  return failed ? undefined : spec;
}

function reference(
  table: Table,
  field: string,
  { pins, vaults }: MapContext,
  fail: (message: string) => void,
): KeyRef | undefined {
  const text = requiredString(table, field, fail);
  if (text === undefined) return undefined;
  const parsed = parseReference(text, vaults);
  if (typeof parsed === "string") {
    fail(`field "${field}" ${parsed}`);
    return undefined;
  }
  const { vault, reference: found } = parsed;
  const parts = Object.entries(found)
    .filter(
      ([part, value]) => part !== "kind" && typeof value === "string" && PLACEHOLDER.test(value),
    )
    .map(([part]) => part);
  if (parts.length) {
    fail(
      `field "${field}" has a <...> placeholder for its ${parts.join(" and ")}: replace it with ${vault.placeholder}`,
    );
    return undefined;
  }
  const pin = pins[vault.kind];
  if (pin === undefined) {
    fail(`field "${field}" ${vault.needsPin}`);
    return undefined;
  }
  return vault.pinned(found, pin);
}

function destination(
  raw: unknown,
  kinds: DestinationKinds,
  fail: (message: string) => void,
): PublishTarget | undefined {
  if (typeof raw === "string") {
    fail(
      `names a shared target, which is no longer supported; write the destination inline, such as { to = "github-actions", repo = "owner/name" } (${OLD_FORMAT})`,
    );
    return undefined;
  }
  if (!isRecord(raw)) {
    fail("must be a table");
    return undefined;
  }
  const to = requiredString(raw, "to", fail);
  if (to === undefined) return undefined;
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  const kind = kinds.find((k) => k.kind === to);
  if (!kind) {
    err(
      `field "to" must be one of: ${kinds
        .map((k) => k.kind)
        .toSorted()
        .join(", ")}`,
    );
    return undefined;
  }
  const target = kind.parse(tableReader(raw, ["to"], kind.kind, err));
  if (target === undefined && !failed)
    err(`the "${kind.kind}" destination couldn't read this table`);
  return failed ? undefined : target;
}

function tableReader(
  table: Table,
  fixed: readonly string[],
  kind: string,
  fail: (m: string) => void,
): TableReader {
  return {
    required: (field) => requiredString(table, field, fail),
    optional: (field) => optionalString(table, field, fail),
    list: (field) => stringList(table, field, fail),
    filledIn: (value, field, what) => filledIn(value, field, what, fail),
    only: (fields, outdated = {}) =>
      unknownFields(table, [...fixed, ...fields], (field) =>
        fail(
          Object.hasOwn(outdated, field)
            ? (outdated[field] ?? "")
            : `unknown field "${field}" for ${kind}`,
        ),
      ),
    fail,
  };
}

function tomlProblem(error: unknown): string {
  if (!(error instanceof TomlError)) return "unknown parse error";
  const first = error.message.replace(/^Invalid TOML document: /, "").split("\n")[0] ?? "";
  const problem = (first.split(/["'`]/)[0] ?? "").replace(/[\s:]+$/, "");
  const said =
    problem === "invalid value" ? "expected a value, and strings must be quoted" : problem;
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
}

function unknownFields(table: Table, known: readonly string[], report: (field: string) => void) {
  for (const field of Object.keys(table)) if (!known.includes(field)) report(field);
}

function requiredString(
  table: Table,
  field: string,
  fail: (message: string) => void,
): string | undefined {
  const value = table[field];
  if (value === undefined) fail(`missing field "${field}"`);
  else if (typeof value !== "string" || !value.trim())
    fail(`field "${field}" must be a non-empty string`);
  else return value;
  return undefined;
}

function stringList(
  table: Table,
  field: string,
  fail: (message: string) => void,
): string[] | undefined {
  const value: unknown = table[field];
  if (value === undefined) fail(`missing field "${field}"`);
  else if (!Array.isArray(value)) fail(`field "${field}" must be a list`);
  else {
    const names = value.filter((each): each is string => typeof each === "string" && !!each.trim());
    if (names.length === value.length) return names;
    fail(`field "${field}" must list non-empty strings`);
  }
  return undefined;
}

function optionalString(
  table: Table,
  field: string,
  fail: (message: string) => void,
): string | undefined {
  return table[field] === undefined ? undefined : requiredString(table, field, fail);
}
