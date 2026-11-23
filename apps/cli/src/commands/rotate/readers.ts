import { dirname } from "node:path";
import { reaches } from "@keypin/core";
import { MAP_FILE } from "../../project";
import type { PlanRow } from "../../publishing";
import { jobReaders } from "../../scan";
import type { Job } from "./job";
import { row } from "./messages";

export async function readerRows({ deps, map, owner }: Job): Promise<PlanRow[]> {
  const found = await jobReaders(deps, dirname(map.file), owner.environment);
  return found.map(({ file, how }) => row("=", file, `runs ${how}`));
}

export function unreadNote({ key, entry, owner }: Job, readers: readonly PlanRow[]): string | null {
  if (reaches(entry)) return null;
  const nowhere = `${MAP_FILE} publishes ${key.name} (${owner.environment}) nowhere`;
  const runs = readers.length
    ? `. The workflows above run secretspec run for ${owner.environment}, so they may read it`
    : `, and no workflow in this repo runs secretspec run for ${owner.environment}`;
  return `${nowhere}${runs}. Check what uses it before you revoke the old key.`;
}
