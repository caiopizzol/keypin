import type { Environment, KeyId, KeyRef, VaultMetadata } from "./contracts";
import { addDays, type Day } from "./days";
import { type EnvEntry, type KeyEntry, type KeysMap, pairedWith } from "./map";

export type Progress = { kind: "unfinished" | "waiting"; since: string; revokes: boolean } | null;

export type DateProblem = "missing" | "unread";

export type DueChoice =
  | { keyId: KeyId; action: "rotate" | "finish"; why: string }
  | { keyId: KeyId; action: "waiting"; why: string; blocked?: Day; date?: DateProblem }
  | { keyId: KeyId; action: "skip"; why: string; date?: "later" | DateProblem };

type Schedule =
  | { kind: "none"; why: string }
  | { kind: "problem"; why: string; date: DateProblem }
  | { kind: "dated"; due: Day };

export function dueRefs(map: KeysMap, environment: Environment): KeyRef[] {
  return map.keys.flatMap((key) => {
    const entry = key.environments[environment];
    return entry?.issuer ? [entry.ref] : [];
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
    const skip = (why: string, date?: "later" | DateProblem): DueChoice[] => [
      { keyId: key.name, action: "skip", why, ...(date ? { date } : {}) },
    ];
    const holder = pairedWith(map, key.name, environment);
    if (holder) return skip(`rotates with ${holder.name}`);
    if (!entry.issuer) return skip("no issuer, so keypin can't make a new key");
    if (entry.idKey !== undefined)
      return skip(
        `its ID is the key ${entry.idKey}; rotate the two with keypin rotate ${key.name}`,
      );
    const progress = input.progress(key.name);
    if (progress?.kind === "unfinished")
      return [
        { keyId: key.name, action: "finish", why: `finishing the rotation from ${progress.since}` },
      ];
    const schedule = scheduleOf(key, entry, input.metadata);
    if (progress?.kind === "waiting") {
      const waits = `rotated ${progress.since}, the old key waits`;
      const choice = { keyId: key.name, action: "waiting" as const, why: waits };
      if (schedule.kind === "problem")
        return [{ ...choice, why: `${waits}; ${schedule.why}`, date: schedule.date }];
      if (schedule.kind === "dated" && schedule.due <= today)
        return [
          { ...choice, why: `${waits}; ${dueWhy(schedule.due, today)}`, blocked: schedule.due },
        ];
      return [choice];
    }
    if (schedule.kind === "none") return skip(schedule.why);
    if (schedule.kind === "problem") return skip(schedule.why, schedule.date);
    if (schedule.due > today) return skip(`not due until ${schedule.due}`, "later");
    return [{ keyId: key.name, action: "rotate", why: dueWhy(schedule.due, today) }];
  });
}

function scheduleOf(
  key: KeyEntry,
  entry: EnvEntry,
  metadata: (ref: KeyRef) => VaultMetadata | null,
): Schedule {
  if (!key.rotateEvery) return { kind: "none", why: "no rotate_every in secretspec.toml" };
  if (key.rotateEvery.days === null) return { kind: "none", why: "never rotates" };
  const read = metadata(entry.ref);
  if (!read)
    return { kind: "problem", why: "the vault's rotated date couldn't be read", date: "unread" };
  if (!read.rotated)
    return { kind: "problem", why: "no rotated date in the vault", date: "missing" };
  return { kind: "dated", due: addDays(read.rotated, key.rotateEvery.days) };
}

function dueWhy(due: Day, today: Day): string {
  return due === today ? "due today" : `was due ${due}`;
}
