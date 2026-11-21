import { type Day, parseDay } from "./days";
import { type Files, writeJsonAtomic } from "./files";
import { isRecord } from "./record";
import type { RotationRecord } from "./rotation-file";
import type { StatusRow } from "./status";

const STATUS_FILE_VERSION = 1;

interface StatusEntry {
  rotated: Day | null;
  rotation?: RotationRecord;
}

export interface StatusFile {
  version: typeof STATUS_FILE_VERSION;
  written: Day;
  keys: Record<string, Record<string, StatusEntry>>;
}

export function statusFile(
  rows: readonly StatusRow[],
  environments: readonly string[],
  written: Day,
  rotation: (keyId: string, environment: string) => RotationRecord | null = () => null,
): StatusFile {
  const keys = new Map<string, Map<string, StatusEntry>>();
  for (const name of [...new Set(rows.map((row) => row.keyId))].sort()) {
    const dates = new Map<string, StatusEntry>();
    for (const environment of environments) {
      const row = rows.find((r) => r.keyId === name && r.environment === environment);
      const record = rotation(name, environment);
      if (row)
        dates.set(environment, { rotated: row.rotated, ...(record ? { rotation: record } : {}) });
    }
    keys.set(name, dates);
  }
  return {
    version: STATUS_FILE_VERSION,
    written,
    keys: Object.fromEntries([...keys].map(([name, dates]) => [name, Object.fromEntries(dates)])),
  };
}

export async function writeStatusFile(
  files: Files,
  path: string,
  file: StatusFile,
): Promise<"written" | "unchanged"> {
  const old = await files.read(path);
  if (old !== null && sameKeys(old, file)) return "unchanged";
  await writeJsonAtomic(files, path, file);
  return "written";
}

function sameKeys(old: string, file: StatusFile): boolean {
  try {
    const data: unknown = JSON.parse(old);
    return JSON.stringify(data) === JSON.stringify({ ...file, written: written(data) });
  } catch {
    return false;
  }
}

function written(data: unknown): unknown {
  return typeof data === "object" && data !== null && "written" in data ? data.written : null;
}

export function statusDates(
  text: string | null,
): (keyId: string, environment: string) => Day | null | undefined {
  const keys = parsed(text);
  return (keyId, environment) => {
    const dates = keys?.[keyId];
    const entry = isRecord(dates) ? dates[environment] : undefined;
    return isRecord(entry) ? rotatedOf(entry) : undefined;
  };
}

export interface RotationRead extends RotationRecord {
  waiting: boolean;
  unfinished: boolean;
}

export interface StatusEntryRead {
  rotated: Day | null;
  rotation: RotationRead | null;
}

export function statusEntries(
  text: string | null,
): Record<string, Record<string, StatusEntryRead>> | null {
  const keys = parsed(text);
  if (keys === null) return null;
  return dictionary(
    Object.entries(keys).flatMap(([keyId, dates]) =>
      isRecord(dates) ? [[keyId, entriesOf(dates)] as const] : [],
    ),
  );
}

function entriesOf(dates: Record<string, unknown>): Record<string, StatusEntryRead> {
  return dictionary(
    Object.entries(dates).flatMap(([environment, entry]) => {
      const read = readEntry(entry);
      return read ? [[environment, read] as const] : [];
    }),
  );
}

function dictionary<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const result: Record<string, T> = {};
  Reflect.setPrototypeOf(result, null);
  for (const [name, value] of entries) result[name] = value;
  return result;
}

function rotatedOf(entry: Record<string, unknown>): Day | null | undefined {
  if (entry.rotated === null) return null;
  return typeof entry.rotated === "string" ? (parseDay(entry.rotated) ?? undefined) : undefined;
}

function readEntry(entry: unknown): StatusEntryRead | null {
  if (!isRecord(entry)) return null;
  const rotated = rotatedOf(entry);
  const rotation = entry.rotation === undefined ? null : readRotation(entry.rotation);
  if (rotated === undefined || rotation === undefined) return null;
  return { rotated, rotation };
}

const OLD: readonly RotationRecord["old"][] = [
  "revoked",
  "waiting for approval",
  "still in use",
  "unknown",
];

const isOld = (value: unknown): value is RotationRecord["old"] => OLD.some((old) => old === value);

const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function readRotation(value: unknown): RotationRead | undefined {
  if (!isRecord(value)) return undefined;
  const { at, published, unpublished, old } = value;
  if (typeof at !== "string" || !isTextList(published) || !isTextList(unpublished))
    return undefined;
  if (!isOld(old)) return undefined;
  return {
    at,
    published,
    unpublished,
    old,
    waiting: old === "waiting for approval",
    unfinished: unpublished.length > 0,
  };
}

function parsed(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) && data.version === STATUS_FILE_VERSION && isRecord(data.keys)
      ? data.keys
      : null;
  } catch {
    return null;
  }
}
