import { envFlag, type ItemIds, messageOf, publishEnvironment } from "@keypin/core";
import { lookUpIds } from "../../publishing";
import type { Job } from "./job";

export async function routineWrites(
  job: Job,
  approvals: (ids: readonly (ItemIds | null)[]) => readonly { approval: string }[],
  looked: ItemIds[] | undefined,
): Promise<boolean> {
  const { key, entry, pair, owner, map, deps, out } = job;
  let ids = looked;
  if (ids === undefined || pair) {
    try {
      ids = await lookUpIds(pair ? [entry.ref, pair.entry.ref] : [entry.ref], deps, out);
    } catch (error) {
      out.line(`Couldn't find the item: ${messageOf(error)}.`);
      return false;
    }
  }
  const needed = approvals(ids);
  if (!needed.length) return true;
  out.line("Needs approval:");
  for (const { approval: what } of needed) out.line(`  ${what}`);
  const env = envFlag(owner.environment, publishEnvironment(map));
  out.line(
    `A scheduled run would stop here. Publish ${key.name} from your laptop (keypin publish ${key.name}${env}), run keypin rotate --due${env} there, and commit .keypin/.`,
  );
  return false;
}
