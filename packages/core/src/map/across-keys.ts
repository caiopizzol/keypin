import type { Environment, KeyId } from "../contracts";
import { type DestinationRules, placeId, secretKey } from "../destination";
import type { IssuerRules } from "../issuer";
import { sameRef } from "../reference";
import type { EnvEntry, KeyEntry } from "./keys-map";
import type { MapContext } from "./key";

export function sharedDestinations(
  keys: KeyEntry[],
  environments: readonly Environment[],
  kinds: readonly DestinationRules[],
  fail: (where: string, message: string) => void,
) {
  const owners = new Map<string, string>();
  for (const key of keys) {
    for (const environment of environments) {
      key.environments[environment]?.publish.forEach((target, i) => {
        const where = `[tool.keypin.${environment}.${key.name}] publish[${i}]`;
        const secret = secretKey(target, key.name, kinds);
        const owner = owners.get(secret);
        if (owner === undefined) owners.set(secret, where);
        else fail(`${where}: `, `writes the same destination secret as ${owner}`);
      });
    }
  }
}

export function sharedClaims(
  keys: KeyEntry[],
  environments: readonly Environment[],
  issuers: readonly IssuerRules[],
  fail: (where: string, message: string) => void,
) {
  const owners = new Map<string, string>();
  for (const key of keys) {
    for (const environment of environments) {
      const spec = key.environments[environment]?.issuer;
      if (!spec) continue;
      const where = `[tool.keypin.${environment}.${key.name}]`;
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

export function pairedKeys(
  keys: KeyEntry[],
  environments: readonly Environment[],
  { kinds, vaults }: Pick<MapContext, "kinds" | "vaults">,
  fail: (where: string, message: string) => void,
) {
  const places = (entry: EnvEntry) =>
    new Set(entry.publish.map((target) => `${placeId(target, kinds)} ${target.account}`));
  for (const environment of environments) {
    const owners = new Map<KeyId, KeyId>();
    for (const key of keys) {
      const entry = key.environments[environment];
      const name = entry?.idKey;
      if (!entry?.issuer || name === undefined) continue;
      const err = (message: string) =>
        fail(`[tool.keypin.${environment}.${key.name}] issuer: `, message);
      const pair = keys.find((k) => k.name === name)?.environments[environment];
      const owner = owners.get(name);
      if (name === key.name)
        err(`field "key_id" names the key itself; name the key that holds its ID`);
      else if (!pair)
        err(
          `field "key_id" names "${name}", which isn't a secret of [profiles.${environment}]; declare it there`,
        );
      else if (owner !== undefined)
        err(
          `[tool.keypin.${environment}.${owner}] also names "${name}" as its key_id; each key needs its own`,
        );
      else if (pair.issuer)
        err(
          `[tool.keypin.${environment}.${name}] has its own issuer; a key_id is rotated with its key, so remove one`,
        );
      else if (
        sameRef(pair.ref, entry.ref, vaults) ||
        (entry.issuer.admin !== undefined && sameRef(pair.ref, entry.issuer.admin, vaults))
      )
        err(
          `"${name}" in [profiles.${environment}] reads the same field as this key or its admin key; give the ID its own field`,
        );
      else if (!sameSet(places(pair), places(entry)))
        err(
          `[tool.keypin.${environment}.${name}] publishes to different destinations; list the same destinations for both keys`,
        );
      else if (entry.pull.length || pair.pull.length)
        err(
          `pulling a key and its key_id isn't supported yet: a job could read the new secret with the old ID between their two vault saves. Publish both keys instead of pulling them`,
        );
      if (!owners.has(name)) owners.set(name, key.name);
    }
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((each) => b.has(each));
}
