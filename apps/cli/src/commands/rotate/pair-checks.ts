import { destinationId, placeId } from "@keypin/core";
import type { Checked } from "../../publishing";
import type { Job } from "./job";

export function pairChecks(
  { pair, deps }: Job,
  checked: Map<string, Checked>,
): Map<string, Checked> {
  const found = new Map<string, Checked>();
  if (!pair) return found;
  const kinds = deps.destinations;
  for (const target of pair.entry.publish) {
    const same = [...checked.values()].find(
      (c) => placeId(c.target, kinds) === placeId(target, kinds),
    );
    if (same) found.set(destinationId(target, pair.key.name, kinds), same);
  }
  return found;
}
