import { formatReference, type ItemIds, type KeyRef } from "@keypin/core";
import type { Deps, Writer } from "./deps";

export function announce(stderr: Writer, what: string, refs: readonly KeyRef[]): void {
  const groups = new Map<string, Set<string>>();
  for (const ref of refs) {
    const where = `1Password account ${ref.account}`;
    groups.set(where, (groups.get(where) ?? new Set()).add(formatReference(ref)));
  }
  for (const [where, references] of groups) {
    stderr.write(`keypin: reading ${what} from ${where}: ${[...references].join(", ")}\n`);
  }
}

export async function lookUpIds(deps: Deps, refs: readonly KeyRef[]): Promise<ItemIds[]> {
  announce(deps.stderr, "the item IDs, not the values,", refs);
  const vault = deps.vault();
  const ids: ItemIds[] = [];
  for (const ref of refs) ids.push(await vault.itemIds(ref));
  return ids;
}

export function distinctRefs(refs: readonly KeyRef[]): KeyRef[] {
  const seen = new Map<string, KeyRef>();
  for (const ref of refs) if (!seen.has(refKey(ref))) seen.set(refKey(ref), ref);
  return [...seen.values()];
}

export const refKey = (ref: KeyRef) =>
  JSON.stringify([ref.kind, ref.account, ref.vault, ref.item, ref.section, ref.field]);
