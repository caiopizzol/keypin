import type { Environment, KeyId, KeyRef } from "../contracts";
import type { PublishTarget } from "../destination";
import { envFileSuffix } from "../dotenv";
import type { IssuerSpec } from "../issuer";

export interface EnvEntry {
  ref: KeyRef;
  publish: PublishTarget[];
  issuer?: IssuerSpec;
  idKey?: KeyId;
}

export interface KeyEntry {
  name: KeyId;
  rotateEvery: { text: string; days: number | null } | null;
  environments: Partial<Record<Environment, EnvEntry>>;
}

export interface KeysMap {
  file: string;
  project: string;
  environments: readonly Environment[];
  ignore: readonly string[];
  keys: KeyEntry[];
}

export type MapResult = { ok: true; map: KeysMap } | { ok: false; errors: string[] };

export function runEnvironment(map: Pick<KeysMap, "environments">): Environment {
  return map.environments.includes(RUN) ? RUN : (map.environments[0] ?? RUN);
}

export function envFileProfile(path: string, map: Pick<KeysMap, "environments">): Environment {
  const suffix = envFileSuffix(path.split("/").at(-1) ?? "");
  return suffix !== undefined && map.environments.includes(suffix) ? suffix : runEnvironment(map);
}

export function publishEnvironment(map: Pick<KeysMap, "environments">): Environment {
  return map.environments.includes(PUBLISH) ? PUBLISH : (map.environments.at(-1) ?? PUBLISH);
}

export function envFlag(environment: Environment, fallback: Environment): string {
  return environment === fallback ? "" : ` --profile ${environment}`;
}

const RUN = "default";
const PUBLISH = "production";

export function pairedWith(
  map: Pick<KeysMap, "keys">,
  name: KeyId,
  environment: Environment,
): KeyEntry | undefined {
  return map.keys.find((key) => key.environments[environment]?.idKey === name);
}

export function reaches(entry: Pick<EnvEntry, "publish">): boolean {
  return entry.publish.length > 0;
}

export function isEnvironmentName(name: string): boolean {
  return ENVIRONMENT_NAME.test(name);
}

export function isVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name);
}

const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]*$/;

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
