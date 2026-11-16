import type { KeyRef, VaultBackend } from "@keypin/core";

export function distinctRefs(refs: readonly KeyRef[]): KeyRef[] {
  const seen = new Map<string, KeyRef>();
  for (const ref of refs) if (!seen.has(refKey(ref))) seen.set(refKey(ref), ref);
  return [...seen.values()];
}

export const refKey = (ref: KeyRef) =>
  JSON.stringify(
    Object.keys(ref)
      .toSorted()
      .map((field) => [field, ref[field]]),
  );

export type Vaults = Readonly<Record<string, () => VaultBackend>>;

export function routedVault(vaults: Vaults): VaultBackend {
  const of = (thing: { kind: string }) => {
    const open = vaults[thing.kind];
    if (!open) throw new Error(`keypin has no vault for ${thing.kind} references`);
    return open();
  };
  return {
    read: (ref) => of(ref).read(ref),
    readItem: (ref) => of(ref).readItem(ref),
    itemIds: (ref) => of(ref).itemIds(ref),
    write: (ref, secret, options) => of(ref).write(ref, secret, options),
    list: (scope) => of(scope).list(scope),
    metadata: (ref) => of(ref).metadata(ref),
  };
}
