import { formatReference, type KeyRef, vaultAccount } from "@keypin/core";
import type { Writer } from "./deps";

export function announce(stderr: Writer, what: string, refs: readonly KeyRef[]): void {
  const groups = new Map<string, Set<string>>();
  for (const ref of refs) {
    const where = vaultAccount(ref);
    groups.set(where, (groups.get(where) ?? new Set()).add(formatReference(ref)));
  }
  for (const [where, references] of groups) {
    stderr.write(`keypin: reading ${what} from ${where}: ${[...references].join(", ")}\n`);
  }
}

export function distinctRefs(refs: readonly KeyRef[]): KeyRef[] {
  const seen = new Map<string, KeyRef>();
  for (const ref of refs) if (!seen.has(refKey(ref))) seen.set(refKey(ref), ref);
  return [...seen.values()];
}

export const refKey = (ref: KeyRef) =>
  JSON.stringify(
    ref.kind === "1password"
      ? [ref.kind, ref.account, ref.vault, ref.item, ref.section, ref.field]
      : [ref.kind, ref.url, ref.organization, ref.project, ref.environment, ref.path, ref.name],
  );
