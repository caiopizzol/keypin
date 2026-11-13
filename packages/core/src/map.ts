import { parse as parseToml, TomlError } from "smol-toml";
import type { Environment, KeyId, KeyRef } from "./contracts";
import { DEFAULT_ENVIRONMENTS } from "./contracts";
import { isRecord } from "./record";
import { parseReference } from "./reference";
import { periodDays } from "./rotation";

export type PublishTarget =
  | { to: "cloudflare-worker"; account: string; worker: string }
  | { to: "github-actions"; repo: string; account: string; environment?: string };

const DESTINATION_KINDS = ["cloudflare-worker", "github-actions"] as const;

export interface EnvEntry {
  ref: KeyRef;
  publish: PublishTarget[];
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
  if (target.to === "cloudflare-worker")
    return `cloudflare-worker:${target.account}:${target.worker}:${secretName}`;
  const place = githubPlace(target.repo.toLowerCase(), target.environment?.toLowerCase());
  return `github-actions:${place}:${secretName.toUpperCase()}`;
}

function githubPlace(repo: string, environment: string | undefined): string {
  return environment === undefined ? repo : `${repo}/environments/${environment}`;
}

const GITHUB_PLACE = /^([^/]+\/[^/]+)(?:\/environments\/(.+))?$/;

export function receiptSecretKey(receipt: {
  destinationId: string;
  account: { pinned: string };
}): string {
  const [to, ...parts] = receipt.destinationId.split(":");
  const name = parts.pop();
  if (to === "cloudflare-worker" && parts.length === 1 && parts[0] && name) {
    return secretKey({ to, account: receipt.account.pinned, worker: parts[0] }, name);
  }
  const github = GITHUB_PLACE.exec(parts.join(":"));
  if (to === "github-actions" && github?.[1] && name) {
    const [, repo, environment] = github;
    return secretKey({ to, repo, account: receipt.account.pinned, environment }, name);
  }
  return receipt.destinationId;
}

function placeId(target: PublishTarget): string {
  return target.to === "cloudflare-worker"
    ? `cloudflare-worker:${target.worker}`
    : `github-actions:${githubPlace(target.repo, target.environment)}`;
}

export function isEnvironmentName(name: string): boolean {
  return ENVIRONMENT_NAME.test(name);
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
  const account = requiredString(raw, "account", fail);
  filledIn(
    account,
    "account",
    "your 1Password account's sign-in address (such as my.1password.com, at the top left of the 1Password app) or its account ID",
    fail,
  );
  return account;
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

  const environments: Record<Environment, EnvEntry> = {};
  Reflect.setPrototypeOf(environments, null);
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
  unknownFields(raw, ["from", "publish"], (field) =>
    err(
      field === "vault" || field === "item"
        ? `"vault" and "item" are from keypin 0.4; use from = "op://<vault>/<item>/<field>" (${OLD_FORMAT})`
        : field === "rotate" || field === "issue"
          ? `the "${field}" section is no longer supported, because keypin rotate is gone; delete it. To rotate the key by hand, replace the value in 1Password, set the item's rotated date to today, then run keypin publish`
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
  if (failed || !ref) return undefined;
  return { ref, publish };
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
  const parts = (["vault", "item", "section", "field"] as const).filter((part) =>
    PLACEHOLDER.test(parsed[part] ?? ""),
  );
  if (parts.length) {
    fail(
      `field "${field}" has a <...> placeholder for its ${parts.join(" and ")}: replace it with the field's secret reference (in 1Password, open the field's menu and select Copy Secret Reference)`,
    );
    return undefined;
  }
  if (account === undefined) {
    fail(`field "${field}" needs your 1Password account: add [1password] with account = "..."`);
    return undefined;
  }
  return { kind: "1password", account, ...parsed };
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

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
    const account = filledIn(
      requiredString(raw, "account", err),
      "account",
      "the Cloudflare account ID the Worker belongs to (32 hex characters; wrangler whoami lists it)",
      err,
    );
    const worker = filledIn(
      requiredString(raw, "worker", err),
      "worker",
      `the Worker's name, the "name" in its wrangler config`,
      err,
    );
    if (account !== undefined && !ACCOUNT_ID.test(account))
      err(`field "account" must be a Cloudflare account ID (32 hex characters)`);
    return failed || account === undefined || worker === undefined
      ? undefined
      : { to, account, worker };
  }
  if (to === "github-actions") {
    unknownFields(raw, ["to", "repo", "environment"], (field) =>
      err(
        field === "account"
          ? `field "account" is from keypin 0.6; the map pins only repo = "owner/name", and each machine publishes as its own GitHub login (git config github.account, else the active gh login). Delete it (${OLD_FORMAT})`
          : `unknown field "${field}" for ${to}`,
      ),
    );
    const repo = filledIn(
      requiredString(raw, "repo", err),
      "repo",
      `the GitHub repository as "owner/name", such as "acme/billing"`,
      err,
    );
    if (repo !== undefined && !REPO.test(repo)) err(`field "repo" must be "owner/name"`);
    const environment = filledIn(
      optionalString(raw, "environment", err),
      "environment",
      "the name of a GitHub environment of the repository, such as production",
      err,
    );
    if (environment !== undefined && (environment.length > 255 || /^\.\.?$/.test(environment)))
      err(
        `field "environment" must be a GitHub environment name, at most 255 characters and not . or ..`,
      );
    if (failed || repo === undefined) return undefined;
    const [account = ""] = repo.split("/");
    const target: PublishTarget = { to, repo, account };
    return environment === undefined ? target : { ...target, environment };
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
