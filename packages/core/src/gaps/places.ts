import type { Environment } from "../contracts";
import type { Place } from "../discovery";
import type { KeyEntry, KeysMap } from "../map";
import type { Need } from "./report";

export interface Found {
  need: Need;
  place: Place;
  key: KeyEntry | null;
}

export function mappedIn(
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

export function proposedIn(place: Place, publish: Environment): Environment {
  const only = place.onlyFrom?.environments ?? [];
  return only.length && !only.includes(publish) ? (only[0] ?? publish) : publish;
}
