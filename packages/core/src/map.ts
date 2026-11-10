import { TOML } from "bun";
import type { Environment, KeyId, KeyRef } from "./contracts";
import { ENVIRONMENTS } from "./contracts";
import { isRecord } from "./record";
import { periodDays } from "./rotation";

export type PublishTarget =
  | { to: "cloudflare-worker"; account: string; worker: string }
  | { to: "github-actions"; repo: string; account: string };

export const DESTINATION_KINDS = ["cloudflare-worker", "github-actions"] as const;

export const PROVIDER_KINDS = ["cloudflare-account-token"] as const;

export interface IssueSpec {
  provider: (typeof PROVIDER_KINDS)[number];
  account: string;
  admin: KeyRef;
}

export interface EnvEntry {
  ref: KeyRef;
  publish: PublishTarget[];
  issue?: IssueSpec;
}

export interface Consumer {
  name: string;
  kind: string;
}

export interface KeyEntry {
  id: KeyId;
  env: string;
  owner: string;
  rotateEvery: string | null;
  environments: Partial<Record<Environment, EnvEntry>>;
  consumers: Consumer[];
}

export interface KeysMap {
  file: string;
  keys: KeyEntry[];
}

export type MapResult = { ok: true; map: KeysMap } | { ok: false; errors: string[] };

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

export function parseMap(text: string, file: string): MapResult {
  let data: unknown;
  try {
    data = TOML.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`${file}: not valid TOML: ${tomlProblem(error)}`],
    };
  }
  return validateMap(data, file);
}

type Table = Record<string, unknown>;

const KEY_ID = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const VAULT_KINDS: readonly string[] = ["1password"];

export function validateMap(data: unknown, file: string): MapResult {
  const errors: string[] = [];
  const fail = (where: string, message: string) => errors.push(`${file}: ${where}${message}`);

  if (!isRecord(data)) return { ok: false, errors: [`${file}: expected a table at the top level`] };
  unknownFields(data, ["vaults", "keys"], (field) =>
    fail("", `unknown top-level field "${field}"`),
  );

  const vaults = new Map<string, Omit<KeyRef, "item">>();
  const rawVaults = data.vaults ?? {};
  if (!isRecord(rawVaults)) fail("", `"vaults" must be a table`);
  else {
    for (const [name, raw] of Object.entries(rawVaults)) {
      const at = `vault "${name}": `;
      if (!isRecord(raw)) {
        fail(at, "must be a table");
        continue;
      }
      unknownFields(raw, ["kind", "account", "vault"], (field) =>
        fail(at, `unknown field "${field}"`),
      );
      const kind = requiredString(raw, "kind", (m) => fail(at, m));
      const account = requiredString(raw, "account", (m) => fail(at, m));
      const vault = requiredString(raw, "vault", (m) => fail(at, m));
      if (kind !== undefined && !VAULT_KINDS.includes(kind)) {
        fail(at, `field "kind" must be one of: ${VAULT_KINDS.join(", ")}`);
      } else if (kind !== undefined && account !== undefined && vault !== undefined) {
        vaults.set(name, { kind: "1password", account, vault });
      }
    }
  }

  const keys: KeyEntry[] = [];
  const rawKeys = data.keys ?? {};
  if (!isRecord(rawKeys)) fail("", `"keys" must be a table`);
  else {
    for (const [id, raw] of Object.entries(rawKeys)) {
      const entry = validateKey(id, raw, vaults, (where, message) =>
        fail(`key "${id}"${where}: `, message),
      );
      if (entry) keys.push(entry);
    }
  }

  sharedDestinations(keys, (where, message) => fail(where, message));
  return errors.length ? { ok: false, errors } : { ok: true, map: { file, keys } };
}

function sharedDestinations(keys: KeyEntry[], fail: (where: string, message: string) => void) {
  const owners = new Map<string, string>();
  for (const key of keys) {
    for (const environment of ENVIRONMENTS) {
      key.environments[environment]?.publish.forEach((target, i) => {
        const where = `key "${key.id}" ${environment} publish[${i}]`;
        const secret = secretKey(target, key.env);
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
  vaults: Map<string, Omit<KeyRef, "item">>,
  fail: (where: string, message: string) => void,
): KeyEntry | undefined {
  let failures = 0;
  const err = (where: string, message: string) => {
    failures++;
    fail(where, message);
  };
  if (!KEY_ID.test(id)) err("", "a key ID uses lowercase letters, digits and dashes");
  if (!isRecord(raw)) {
    err("", "must be a table");
    return undefined;
  }
  unknownFields(raw, ["env", "owner", "rotate_every", "consumers", ...ENVIRONMENTS], (field) =>
    err("", `unknown field "${field}"`),
  );
  const env = requiredString(raw, "env", (m) => err("", m));
  if (env !== undefined && !ENV_NAME.test(env))
    err(
      "",
      `field "env" must be a variable name: letters, digits and _, not starting with a digit`,
    );
  const owner = requiredString(raw, "owner", (m) => err("", m));
  const rotateEvery = optionalString(raw, "rotate_every", (m) => err("", m));
  if (rotateEvery !== undefined && periodDays(rotateEvery) === undefined) {
    err("", `field "rotate_every" must be <n>d, <n>w, <n>m or never`);
  }

  const environments: Partial<Record<Environment, EnvEntry>> = {};
  for (const name of ENVIRONMENTS) {
    if (raw[name] === undefined) continue;
    const entry = validateEnv(raw[name], vaults, (m) => err(` ${name}`, m));
    if (entry) environments[name] = entry;
  }
  for (const [name, entry] of Object.entries(environments)) {
    const index = entry.publish.findIndex((target) => target.to === "github-actions");
    if (env !== undefined && index !== -1 && /^GITHUB_/i.test(env)) {
      err(
        ` ${name}`,
        `publish[${index}]: github-actions can't take this key, because GitHub reserves secret names that start with GITHUB_; rename field "env"`,
      );
    }
  }
  if (!ENVIRONMENTS.some((name) => raw[name] !== undefined)) {
    err("", `needs at least one of ${ENVIRONMENTS.map((n) => `"${n}"`).join(", ")}`);
  }

  const consumers: Consumer[] = [];
  if (raw.consumers !== undefined) {
    if (!Array.isArray(raw.consumers)) err("", `field "consumers" must be a list`);
    else {
      raw.consumers.forEach((c: unknown, i: number) => {
        const at = ` consumers[${i}]`;
        if (!isRecord(c)) return err(at, "must be a table");
        unknownFields(c, ["name", "kind"], (field) => err(at, `unknown field "${field}"`));
        const name = requiredString(c, "name", (m) => err(at, m));
        const kind = requiredString(c, "kind", (m) => err(at, m));
        if (name !== undefined && kind !== undefined) consumers.push({ name, kind });
      });
    }
  }

  if (failures || env === undefined || owner === undefined) return undefined;
  return { id, env, owner, rotateEvery: rotateEvery ?? null, environments, consumers };
}

function validateEnv(
  raw: unknown,
  vaults: Map<string, Omit<KeyRef, "item">>,
  fail: (message: string) => void,
): EnvEntry | undefined {
  if (!isRecord(raw)) {
    fail("must be a table");
    return undefined;
  }
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  unknownFields(raw, ["vault", "item", "publish", "issue"], (field) =>
    err(`unknown field "${field}"`),
  );
  const vaultName = requiredString(raw, "vault", err);
  const item = requiredString(raw, "item", err);
  const vault = vaultName === undefined ? undefined : vaults.get(vaultName);
  if (vaultName !== undefined && !vault)
    err(`field "vault" names a vault that isn't under [vaults]`);

  const publish: PublishTarget[] = [];
  const firstAt = new Map<string, number>();
  if (raw.publish !== undefined) {
    if (!Array.isArray(raw.publish)) err(`field "publish" must be a list`);
    else {
      raw.publish.forEach((t: unknown, i: number) => {
        const target = validateTarget(t, (m) => err(`publish[${i}]: ${m}`));
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
  const issue =
    raw.issue === undefined || !vault || item === undefined
      ? undefined
      : validateIssue(raw.issue, vault, item, (m) => err(`issue: ${m}`));
  if (failed || !vault || item === undefined) return undefined;
  return { ref: { ...vault, item }, publish, ...(issue ? { issue } : {}) };
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

function validateIssue(
  raw: unknown,
  vault: Omit<KeyRef, "item">,
  item: string,
  fail: (message: string) => void,
): IssueSpec | undefined {
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
  const admin = requiredString(raw, "admin", err);
  const kind = PROVIDER_KINDS.find((known) => known === provider);
  if (provider !== undefined && !kind)
    err(`field "provider" must be one of: ${PROVIDER_KINDS.join(", ")}`);
  if (account !== undefined && !ACCOUNT_ID.test(account))
    err(`field "account" must be a Cloudflare account ID (32 hex characters)`);
  if (admin !== undefined && admin === item)
    err(`field "admin" names the key's own item; the admin token needs its own item`);
  if (failed || !kind || account === undefined || admin === undefined) return undefined;
  return { provider: kind, account, admin: { ...vault, item: admin } };
}

function validateTarget(raw: unknown, fail: (message: string) => void): PublishTarget | undefined {
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
    return failed || account === undefined || worker === undefined
      ? undefined
      : { to, account, worker };
  }
  if (to === "github-actions") {
    unknownFields(raw, ["to", "repo", "account"], (field) =>
      err(`unknown field "${field}" for ${to}`),
    );
    const repo = requiredString(raw, "repo", err);
    const account = optionalString(raw, "account", err);
    if (repo !== undefined && !REPO.test(repo)) err(`field "repo" must be "owner/name"`);
    return failed || repo === undefined
      ? undefined
      : { to, repo, account: account ?? repo.split("/")[0] };
  }
  err(`field "to" must be one of: ${DESTINATION_KINDS.join(", ")}`);
  return undefined;
}

function tomlProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown parse error";
  const problem = message.replace(/^TOML Parse error: /, "").split(/["']|\(0x/)[0] ?? "";
  return problem.replace(/(\s+but)?\s+found\s*$/, "").replace(/[\s:]+$/, "");
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
