import { parse as parseToml, TomlError } from "smol-toml";
import type { DestinationRules } from "../destination";
import type { IssuerRules } from "../issuer";
import type { VaultRules } from "../login";
import { isRecord } from "../record";
import type { MapResult } from "./keys-map";
import { sharedDestinations, sharedClaims, pairedKeys } from "./across-keys";
import { readProfiles } from "./secretspec";
import { readTool } from "./tool";

export { projectDefaults, SECRETSPEC_FILE } from "./secretspec";
export {
  envFlag,
  ignores,
  isEnvironmentName,
  isVariableName,
  pairedWith,
  publishEnvironment,
  reaches,
  runEnvironment,
  envFileProfile,
  type EnvEntry,
  type KeyEntry,
  type KeysMap,
  type MapResult,
} from "./keys-map";

export function readSecretspec(
  text: string,
  file: string,
  kinds: readonly DestinationRules[],
  issuers: readonly IssuerRules[],
  vaults: readonly VaultRules[],
): MapResult {
  let data: unknown;
  try {
    data = parseToml(text);
  } catch (error) {
    return { ok: false, errors: [`${file}: not valid TOML: ${tomlProblem(error)}`] };
  }
  if (!isRecord(data)) return { ok: false, errors: [`${file}: expected a table at the top level`] };
  const errors: string[] = [];
  const fail = (where: string, message: string) => errors.push(`${file}: ${where}${message}`);
  const profiles = readProfiles(data, vaults, fail);
  if (!profiles) return { ok: false, errors };
  const { environments, project } = profiles;
  const context = { environments, kinds, issuers, vaults };
  const tool = isRecord(data.tool) ? data.tool.keypin : undefined;
  const { keys, ignore, scanFiles } = readTool(tool, profiles, context, fail);
  sharedDestinations(keys, environments, kinds, fail);
  sharedClaims(keys, environments, issuers, fail);
  pairedKeys(keys, environments, { kinds, vaults }, fail);
  return errors.length
    ? { ok: false, errors }
    : { ok: true, map: { file, project, environments, ignore, scanFiles, keys } };
}

function tomlProblem(error: unknown): string {
  if (!(error instanceof TomlError)) return "unknown parse error";
  const first = error.message.replace(/^Invalid TOML document: /, "").split("\n")[0] ?? "";
  const problem = (first.split(/["'`]/)[0] ?? "").replace(/[\s:]+$/, "");
  const said =
    problem === "invalid value" ? "expected a value, and strings must be quoted" : problem;
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
}
