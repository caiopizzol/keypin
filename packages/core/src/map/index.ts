import { parse as parseToml, TomlError } from "smol-toml";
import type { Environment } from "../contracts";
import { DEFAULT_ENVIRONMENTS } from "../contracts";
import type { DestinationRules } from "../destination";
import type { IssuerRules } from "../issuer";
import type { VaultRules } from "../login";
import type { PullKinds } from "../pull";
import { isRecord } from "../record";
import { byKind } from "../reference";
import {
  type KeyEntry,
  type VaultPins,
  type MapResult,
  isEnvironmentName,
  VARIABLE_NAME,
} from "./keys-map";
import { sharedDestinations, sharedClaims, pairedKeys } from "./across-keys";
import { OLD_FORMAT, type MapContext, validateKey } from "./key";
import { type Table, tableReader, unknownFields } from "./table";

export {
  envFlag,
  isEnvironmentName,
  isVariableName,
  pairedWith,
  publishEnvironment,
  reaches,
  runEnvironment,
  type EnvEntry,
  type KeyEntry,
  type KeysMap,
  type MapResult,
  type VaultPins,
} from "./keys-map";

export function parseMap(
  text: string,
  file: string,
  kinds: readonly DestinationRules[],
  issuers: readonly IssuerRules[],
  vaults: readonly VaultRules[],
  pulls: PullKinds = [],
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
  return validateMap(data, file, { kinds, issuers, vaults, pulls });
}

function validateMap(
  data: unknown,
  file: string,
  { kinds, issuers, vaults, pulls }: Pick<MapContext, "kinds" | "issuers" | "vaults" | "pulls">,
): MapResult {
  const errors: string[] = [];
  const fail = (where: string, message: string) => errors.push(`${file}: ${where}${message}`);

  if (!isRecord(data)) return { ok: false, errors: [`${file}: expected a table at the top level`] };
  unknownFields(data, ["environments", "ignore", ...vaults.map((v) => v.kind), "keys"], (field) =>
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
      const context = { pins, environments, kinds, issuers, vaults, pulls };
      const entry = validateKey(id, raw, context, (where, message) =>
        fail(`${label}${where}: `, message),
      );
      if (entry) keys.push(entry);
    });
  }

  const ignore = validateIgnore(data.ignore, isRecord(rawKeys) ? Object.keys(rawKeys) : [], (m) =>
    fail("", m),
  );
  sharedDestinations(keys, environments, kinds, (where, message) => fail(where, message));
  sharedClaims(keys, environments, issuers, (where, message) => fail(where, message));
  pairedKeys(keys, environments, { kinds, vaults }, (where, message) => fail(where, message));
  return errors.length
    ? { ok: false, errors }
    : { ok: true, map: { file, pins, environments, ignore, keys } };
}

function validateIgnore(
  raw: unknown,
  mapped: readonly string[],
  fail: (message: string) => void,
): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((name) => typeof name === "string")) {
    fail(`"ignore" must be a list of variable names, such as ["OPENAI_API_KEY"]`);
    return [];
  }
  const names: string[] = [];
  for (const name of raw) {
    const key = mapped.find((id) => id.toUpperCase() === name.toUpperCase());
    if (!VARIABLE_NAME.test(name))
      fail(
        `ignore "${name}": a variable name uses letters, digits and _, not starting with a digit`,
      );
    else if (names.some((each) => each.toUpperCase() === name.toUpperCase()))
      fail(`ignore "${name}" is listed twice`);
    else if (key !== undefined)
      fail(`ignore "${name}" is also [keys.${key}]; remove it from one of them`);
    else names.push(name);
  }
  return names;
}

function validatePins(
  data: Table,
  vaults: readonly VaultRules[],
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

function tomlProblem(error: unknown): string {
  if (!(error instanceof TomlError)) return "unknown parse error";
  const first = error.message.replace(/^Invalid TOML document: /, "").split("\n")[0] ?? "";
  const problem = (first.split(/["'`]/)[0] ?? "").replace(/[\s:]+$/, "");
  const said =
    problem === "invalid value" ? "expected a value, and strings must be quoted" : problem;
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
}
