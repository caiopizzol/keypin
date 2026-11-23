import {
  type KeysMap,
  type RotationFile,
  type EnvEntry,
  envFlag,
  type Issuer,
  type IssuerSpec,
  type ItemIds,
  type KeyEntry,
  type KeyOwner,
  pairedWith,
  publishEnvironment,
  type RemovedDestination,
  vaultName,
  vaultKindOf,
} from "@keypin/core";
import { type Deps } from "../../deps";
import { type Output } from "../../output";
import { type Checked, type Label, labels } from "../../publishing";

export interface Pair {
  key: KeyEntry;
  entry: EnvEntry;
}

export interface Job {
  key: KeyEntry;
  entry: EnvEntry;
  spec: IssuerSpec;
  owner: KeyOwner;
  pair: Pair | null;
  yes: boolean;
  plan: boolean;
  due: boolean;
  approve: boolean;
  check: boolean;
  discard: boolean;
  args: string[];
  envArgs: string[];
  map: KeysMap;
  committed: RotationFile | null;
  deps: Deps;
  out: Output;
  label: Label;
  path: string;
}

export type Flags = Pick<Job, "yes" | "plan" | "due" | "approve" | "check" | "discard" | "args">;

export interface Ready {
  ids: ItemIds;
  pairIds: ItemIds | null;
  issuer: Issuer;
  checked: Map<string, Checked>;
  pairChecked: Map<string, Checked>;
  removed: RemovedDestination[];
}

export interface Context {
  map: KeysMap;
  environment: string;
  envArgs: string[];
  committed: RotationFile | null;
  deps: Deps;
  out: Output;
}

export function jobFor(context: Context, keyId: string, flags: Flags): Omit<Job, "path"> {
  const { map, environment, deps } = context;
  const key = map.keys.find((k) => k.name === keyId);
  if (!key) throw new Error(`${map.file} has no key "${keyId}"`);
  const entry = key.environments[environment];
  if (!entry)
    throw new Error(`${keyId} isn't a secret of [profiles.${environment}] in ${map.file}`);
  const spec = entry.issuer;
  const holder = spec ? undefined : pairedWith(map, keyId, environment);
  if (holder)
    throw new Error(
      `${keyId} in profile ${environment} holds the ID of ${holder.name}, and keypin rotates the two together. Run keypin rotate ${holder.name}${envFlag(environment, publishEnvironment(map))}.`,
    );
  if (!spec)
    throw new Error(
      `[tool.keypin.${environment}.${keyId}] has no issuer in ${map.file}, so keypin can't make a new key. Add one (see docs/guides/rotating-a-key.md), or rotate it by hand.`,
    );
  const pairKey = map.keys.find((k) => k.name === entry.idKey);
  const pairEntry = pairKey?.environments[environment];
  const pair = pairKey && pairEntry ? { key: pairKey, entry: pairEntry } : null;
  const holds = pair
    ? [entry.ref, pair.entry.ref].find((ref) => vaultKindOf(deps.vaults, ref.kind).holdsWrites)
    : undefined;
  if (pair && holds)
    throw new Error(
      `${vaultName(holds, deps.vaults)} may hold a change for approval, which would leave ${keyId} and its ID ${pair.key.name} saved apart, so keypin can't rotate them. Rotate both by hand.`,
    );
  if (!spec.admin && vaultKindOf(deps.vaults, entry.ref.kind).holdsWrites)
    throw new Error(
      `${vaultName(entry.ref, deps.vaults)} may hold a change for approval, and keypin couldn't tell later whether the ${spec.kind} value it made was approved or rejected, so it can't rotate ${keyId}. Make a new value yourself, save it, then run keypin publish ${keyId}${envFlag(environment, publishEnvironment(map))}.`,
    );
  return {
    ...context,
    ...flags,
    key,
    entry,
    spec,
    owner: { keyId, environment, mapFile: map.file },
    pair,
    label: labels(entry.publish, deps.destinations),
  };
}

export function withoutDiscard(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== "--discard");
}

export function terminalArgs(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== "--yes" && arg !== "--check");
}
