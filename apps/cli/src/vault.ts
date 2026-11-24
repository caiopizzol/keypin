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

export function closeVault(deps: { vault(): VaultBackend }): Promise<void> {
  return Promise.resolve()
    .then(() => deps.vault().close?.())
    .catch(() => undefined);
}

type Vaults = Readonly<Record<string, () => VaultBackend>>;

export function routedVault(vaults: Vaults): VaultBackend {
  const opened = new Set<() => VaultBackend>();
  const of = (thing: { kind: string }) => {
    const open = vaults[thing.kind];
    if (!open) throw new Error(`keypin has no vault for ${thing.kind} references`);
    const backend = open();
    opened.add(open);
    return backend;
  };
  return {
    read: (ref) => of(ref).read(ref),
    readItem: (ref) => of(ref).readItem(ref),
    itemIds: (ref) => of(ref).itemIds(ref),
    write: (ref, secret, options) => of(ref).write(ref, secret, options),
    checkWrite: async (ref) => of(ref).checkWrite?.(ref),
    list: (scope) => of(scope).list(scope),
    metadata: (ref) => of(ref).metadata(ref),
    notes: async (refs) => {
      const kinds = [...new Set(refs.map((ref) => ref.kind))];
      const notes = await Promise.all(
        kinds.map(async (kind) => {
          const open = vaults[kind];
          if (!open || !opened.has(open)) return [];
          return (await open().notes?.(refs.filter((ref) => ref.kind === kind))) ?? [];
        }),
      );
      return notes.flat();
    },
    close: async () => {
      const open = [...opened];
      opened.clear();
      await Promise.all(open.map(async (backend) => backend().close?.()));
    },
  };
}
