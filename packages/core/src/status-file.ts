import type { Day } from "./days";
import { type Files, writeJsonAtomic } from "./files";
import type { StatusRow } from "./status";

const STATUS_FILE_VERSION = 1;

export interface StatusFile {
  version: typeof STATUS_FILE_VERSION;
  written: Day;
  keys: Record<string, Record<string, { rotated: Day | null }>>;
}

export function statusFile(
  rows: readonly StatusRow[],
  environments: readonly string[],
  written: Day,
): StatusFile {
  const keys: StatusFile["keys"] = {};
  for (const name of [...new Set(rows.map((row) => row.keyId))].sort()) {
    const dates: Record<string, { rotated: Day | null }> = {};
    for (const environment of environments) {
      const row = rows.find((r) => r.keyId === name && r.environment === environment);
      if (row) dates[environment] = { rotated: row.rotated };
    }
    keys[name] = dates;
  }
  return { version: STATUS_FILE_VERSION, written, keys };
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
