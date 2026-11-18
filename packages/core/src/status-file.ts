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
    if (!isRecord(entry)) return undefined;
    if (entry.rotated === null) return null;
    return typeof entry.rotated === "string" ? (parseDay(entry.rotated) ?? undefined) : undefined;
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
