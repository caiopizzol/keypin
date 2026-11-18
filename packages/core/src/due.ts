import type { Environment, KeyId, KeyRef, VaultMetadata } from "./contracts";
import { addDays, type Day } from "./days";
import { type KeysMap, pairedWith } from "./map";

export type Progress = { kind: "unfinished" | "waiting"; since: string; revokes: boolean } | null;

export type DueChoice =
  | { keyId: KeyId; action: "rotate" | "finish"; why: string }
  | { keyId: KeyId; action: "waiting"; why: string }
  | { keyId: KeyId; action: "skip"; why: string; date?: "later" | "missing" };

export function dueRefs(map: KeysMap, environment: Environment): KeyRef[] {
  return map.keys.flatMap((key) => {
    const entry = key.environments[environment];
    return entry?.issuer && entry.publish.length ? [entry.ref] : [];
  });
}

export function dueKeys(input: {
  map: KeysMap;
  environment: Environment;
  today: Day;
  metadata: (ref: KeyRef) => VaultMetadata | null;
  progress: (keyId: KeyId) => Progress;
}): DueChoice[] {
  const { map, environment, today } = input;
  return map.keys.flatMap((key): DueChoice[] => {
    const entry = key.environments[environment];
    if (!entry) return [];
    const skip = (why: string, date?: "later" | "missing"): DueChoice[] => [
      { keyId: key.name, action: "skip", why, ...(date ? { date } : {}) },
    ];
    const holder = pairedWith(map, key.name, environment);
    if (holder) return skip(`rotates with ${holder.name}`);
    if (!entry.issuer) return skip("no issuer, so keypin can't make a new key");
    if (entry.idKey !== undefined)
      return skip(
        `its ID is the key ${entry.idKey}; rotate the two with keypin rotate ${key.name}`,
      );
    if (!entry.publish.length) return skip("no destination for the new key");
    const progress = input.progress(key.name);
    if (progress?.kind === "waiting")
      return [
        { keyId: key.name, action: "waiting", why: `rotated ${progress.since}, the old key waits` },
      ];
    if (progress?.kind === "unfinished")
      return [
        { keyId: key.name, action: "finish", why: `finishing the rotation from ${progress.since}` },
      ];
    if (!key.rotateEvery) return skip("no rotate_every in the map");
    if (key.rotateEvery.days === null) return skip("never rotates");
    const metadata = input.metadata(entry.ref);
    if (!metadata) return skip("the vault's rotated date couldn't be read", "missing");
    if (!metadata.rotated) return skip("no rotated date in the vault", "missing");
    const due = addDays(metadata.rotated, key.rotateEvery.days);
    if (due > today) return skip(`not due until ${due}`, "later");
    return [
      { keyId: key.name, action: "rotate", why: due === today ? "due today" : `was due ${due}` },
    ];
  });
}
