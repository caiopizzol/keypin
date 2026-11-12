import { parse as parseToml, TomlError } from "smol-toml";
import type { Environment, KeyId, KeyRef } from "./contracts";
import { DEFAULT_ENVIRONMENTS } from "./contracts";
import { isRecord } from "./record";
import { parseReference, sameItem } from "./reference";
import { periodDays } from "./rotation";

export type PublishTarget =
  | { to: "cloudflare-worker"; account: string; worker: string }
  | { to: "github-actions"; repo: string; account: string };

const DESTINATION_KINDS = ["cloudflare-worker", "github-actions"] as const;

const PROVIDER_KINDS = ["cloudflare-account-token"] as const;

export interface RotateSpec {
  provider: (typeof PROVIDER_KINDS)[number];
  account: string;
  admin: KeyRef;
}

export interface EnvEntry {
  ref: KeyRef;
  publish: PublishTarget[];
  rotate?: RotateSpec;
}

export interface KeyEntry {
  name: KeyId;
  rotateEvery: string | null;
  environments: Partial<Record<Environment, EnvEntry>>;
}

export interface KeysMap {
  file: string;
  account: string | null;
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

export function destinationId(target: PublishTarget, secretName: string): string {
  return `${placeId(target)}:${secretName}`;
}

export function secretKey(target: PublishTarget, secretName: string): string {
  return target.to === "cloudflare-worker"
    ? `cloudflare-worker:${target.account}:${target.worker}:${secretName}`
    : `github-actions:${target.repo.toLowerCase()}:${secretName.toUpperCase()}`;
}

export function receiptSecretKey(receipt: {
  destinationId: string;
  account: { pinned: string };
}): string {
  const [to, place, name, ...rest] = receipt.destinationId.split(":");
  if (rest.length || place === undefined || name === undefined) return receipt.destinationId;
  if (to === "cloudflare-worker") {
    return secretKey({ to, account: receipt.account.pinned, worker: place }, name);
  }
  if (to === "github-actions") {
    return secretKey({ to, repo: place, account: receipt.account.pinned }, name);
  }
  return receipt.destinationId;
}

function placeId(target: PublishTarget): string {
  return target.to === "cloudflare-worker"
    ? `cloudflare-worker:${target.worker}`
    : `github-actions:${target.repo}`;
}

export function isVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name);
}

export function parseMap(text: string, file: string): MapResult {
  let data: unknown;
  try {
    data = parseToml(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`${file}: not valid TOML: ${tomlProblem(error)}`],
    };
  }
  return validateMap(data, file);
}

type Table = Record<string, unknown>;

const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]*$/;
const KEY_FIELDS: readonly string[] = ["rotate_every"];
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const REMOVED_KEY_FIELDS: readonly string[] = ["owner", "consumers"];
const OLD_FORMAT = "see docs/configuration.md for the current format";

function validateMap(data: unknown, file: string): MapResult {
  const errors: string[] = [];
  const fail = (where: string, message: string) => errors.push(`${file}: ${where}${message}`);

  if (!isRecord(data)) return { ok: false, errors: [`${file}: expected a table at the top level`] };
  unknownFields(data, ["environments", "1password", "keys"], (field) =>
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
  const account = validateAccount(data["1password"], (message) => fail("[1password]: ", message));

  const keys: KeyEntry[] = [];
  const rawKeys = data.keys ?? {};
  if (!isRecord(rawKeys)) fail("", `"keys" must be a table`);
  else {
    Object.entries(rawKeys).forEach(([id, raw], index) => {
      const label = VARIABLE_NAME.test(id) ? `key "${id}"` : `keys[${index}]`;
      const entry = validateKey(id, raw, account, environments, (where, message) =>
        fail(`${label}${where}: `, message),
      );
      if (entry) keys.push(entry);
    });
  }

  sharedDestinations(keys, environments, (where, message) => fail(where, message));
  return errors.length
    ? { ok: false, errors }
    : { ok: true, map: { file, account: account ?? null, environments, keys } };
}

function validateAccount(raw: unknown, fail: (message: string) => void): string | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    fail("must be a table");
    return undefined;
  }
  unknownFields(raw, ["account"], (field) => fail(`unknown field "${field}"`));
  return requiredString(raw, "account", fail);
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
    if (!ENVIRONMENT_NAME.test(name)) {
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
  fail: (where: string, message: string) => void,
) {
  const owners = new Map<string, string>();
  for (const key of keys) {
    for (const environment of environments) {
      key.environments[environment]?.publish.forEach((target, i) => {
        const where = `key "${key.name}" ${environment} publish[${i}]`;
        const secret = secretKey(target, key.name);
        const owner = owners.get(secret);
        if (owner === undefined) owners.set(secret, where);
        else fail(`${where}: `, `writes the same destination secret as ${owner}`);
      });
    }
  }
}

function validateKey(
  id: string,
  raw: unknown,
  account: string | undefined,
  environmentNames: readonly Environment[],
  fail: (where: string, message: string) => void,
): KeyEntry | undefined {
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

  const environments: Record<Environment, EnvEntry> = Object.create(null);
  const declared = environmentNames.filter((name) => Object.hasOwn(raw, name));
  for (const name of declared) {
    const entry = validateEnv(raw[name], account, (m) => err(` ${name}`, m));
    if (entry) environments[name] = entry;
  }
  for (const [name, entry] of Object.entries(environments)) {
    const index = entry.publish.findIndex((target) => target.to === "github-actions");
    if (index !== -1 && /^GITHUB_/i.test(id)) {
      err(
        ` ${name}`,
        `publish[${index}]: github-actions can't take this key, because GitHub reserves secret names that start with GITHUB_`,
      );
    }
  }
  if (!declared.length) {
    err("", `needs at least one of ${environmentNames.map((n) => `"${n}"`).join(", ")}`);
  }

  if (failures) return undefined;
  return { name: id, rotateEvery: rotateEvery ?? null, environments };
}

function validateEnv(
  given: unknown,
  account: string | undefined,
  fail: (message: string) => void,
): EnvEntry | undefined {
  const raw = typeof given === "string" ? { from: given } : given;
  if (!isRecord(raw)) {
    fail(`must be an op:// reference, or a table with "from"`);
    return undefined;
  }
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  unknownFields(raw, ["from", "publish", "rotate"], (field) =>
    err(
      field === "vault" || field === "item"
        ? `"vault" and "item" are from keypin 0.4; use from = "op://<vault>/<item>/<field>" (${OLD_FORMAT})`
        : field === "issue"
          ? `the "issue" section is from keypin 0.5; rename it to "rotate" (${OLD_FORMAT})`
          : `unknown field "${field}"`,
    ),
  );
  const ref = reference(raw, "from", account, err);

  const publish: PublishTarget[] = [];
  const firstAt = new Map<string, number>();
  if (raw.publish !== undefined) {
    if (!Array.isArray(raw.publish)) err(`field "publish" must be a list`);
    else {
      raw.publish.forEach((t: unknown, i: number) => {
        const target = destination(t, (m) => err(`publish[${i}]: ${m}`));
        if (!target) return;
        const same = firstAt.get(placeId(target));
        if (same !== undefined) err(`publish[${i}]: the same destination as publish[${same}]`);
        else {
          firstAt.set(placeId(target), i);
          publish.push(target);
        }
      });
    }
  }
  const rotate =
    raw.rotate === undefined || !ref
      ? undefined
      : validateRotate(raw.rotate, ref, account, (m) => err(`rotate: ${m}`));
  if (failed || !ref) return undefined;
  return { ref, publish, ...(rotate ? { rotate } : {}) };
}

function reference(
  table: Table,
  field: string,
  account: string | undefined,
  fail: (message: string) => void,
): KeyRef | undefined {
  const text = requiredString(table, field, fail);
  if (text === undefined) return undefined;
  const parsed = parseReference(text);
  if (typeof parsed === "string") {
    fail(`field "${field}" ${parsed}`);
    return undefined;
  }
  if (account === undefined) {
    fail(`field "${field}" needs your 1Password account: add [1password] with account = "..."`);
    return undefined;
  }
  return { kind: "1password", account, ...parsed };
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

function validateRotate(
  raw: unknown,
  own: KeyRef,
  vaultAccount: string | undefined,
  fail: (message: string) => void,
): RotateSpec | undefined {
  if (!isRecord(raw)) {
    fail("must be a table");
    return undefined;
  }
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  unknownFields(raw, ["provider", "account", "admin"], (field) => err(`unknown field "${field}"`));
  const provider = requiredString(raw, "provider", err);
  const account = requiredString(raw, "account", err);
  const admin = reference(raw, "admin", vaultAccount, err);
  const kind = PROVIDER_KINDS.find((known) => known === provider);
  if (provider !== undefined && !kind)
    err(`field "provider" must be one of: ${PROVIDER_KINDS.join(", ")}`);
  if (account !== undefined && !ACCOUNT_ID.test(account))
    err(`field "account" must be a Cloudflare account ID (32 hex characters)`);
  if (admin && sameItem(admin, own))
    err(`field "admin" names the key's own item; the admin token needs its own item`);
  if (failed || !kind || account === undefined || admin === undefined) return undefined;
  return { provider: kind, account, admin };
}

function destination(raw: unknown, fail: (message: string) => void): PublishTarget | undefined {
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
  if (to === "cloudflare-worker") {
    unknownFields(raw, ["to", "account", "worker"], (field) =>
      err(`unknown field "${field}" for ${to}`),
    );
    const account = requiredString(raw, "account", err);
    const worker = requiredString(raw, "worker", err);
    if (account !== undefined && !ACCOUNT_ID.test(account))
      err(`field "account" must be a Cloudflare account ID (32 hex characters)`);
    return failed || account === undefined || worker === undefined
      ? undefined
      : { to, account, worker };
  }
  if (to === "github-actions") {
    unknownFields(raw, ["to", "repo"], (field) =>
      err(
        field === "account"
          ? `field "account" is from keypin 0.6; the map pins only repo = "owner/name", and each machine publishes as its own GitHub login (git config github.account, else the active gh login). Delete it (${OLD_FORMAT})`
          : `unknown field "${field}" for ${to}`,
      ),
    );
    const repo = requiredString(raw, "repo", err);
    if (repo !== undefined && !REPO.test(repo)) err(`field "repo" must be "owner/name"`);
    return failed || repo === undefined ? undefined : { to, repo, account: repo.split("/")[0] };
  }
  err(`field "to" must be one of: ${DESTINATION_KINDS.join(", ")}`);
  return undefined;
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

function optionalString(
  table: Table,
  field: string,
  fail: (message: string) => void,
): string | undefined {
  return table[field] === undefined ? undefined : requiredString(table, field, fail);
}
