import { dirname } from "node:path";
import { reaches } from "@keypin/core";
import { MAP_FILE } from "../../project";
import type { PlanRow } from "../../publishing";
import { jobReaders } from "../../scan";
import type { Job } from "./job";
import { row } from "./messages";

export async function readerRows({ deps, map, owner }: Job): Promise<PlanRow[]> {
  const found = await jobReaders(deps, dirname(map.file), owner.environment);
  return found.map(({ file, how }) => row("=", file, `reads it at job time (${how})`));
}

export function unreadNote({ key, entry, owner }: Job, readers: readonly PlanRow[]): string | null {
  if (readers.length || reaches(entry)) return null;
  return `${MAP_FILE} publishes ${key.name} (${owner.environment}) nowhere, and nothing in this repo reads it at job time. Check what uses it before you revoke the old key.`;
}
