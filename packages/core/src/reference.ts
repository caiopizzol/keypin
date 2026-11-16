import type { KeyRef } from "./contracts";
import type { VaultKind, VaultKinds } from "./login";
import { isRecord } from "./record";

function vaultKindOf<V extends VaultKind>(vaults: readonly V[], kind: string): V {
  const found = vaults.find((vault) => vault.kind === kind);
  if (!found) throw new Error(`keypin has no vault kind "${kind}"`);
  return found;
}

export function byKind<V extends VaultKind>(vaults: readonly V[]): V[] {
  return vaults.toSorted((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

export function referenceSchemes(vaults: VaultKinds): string {
  return byKind(vaults)
    .map((vault) => vault.scheme)
    .join(" or ");
}

export function parseReference(
  text: string,
  vaults: VaultKinds,
): { vault: VaultKind; reference: KeyRef } | string {
  const query = /[?#].*$/s.exec(text)?.[0];
  if (query)
    return `can't have the query ${JSON.stringify(query)}; keypin reads the field's value as stored`;
  const vault = vaults.find((v) => text.startsWith(v.scheme));
  if (!vault) return `must start with ${referenceSchemes(vaults)}`;
  const reference = vault.parse(text.slice(vault.scheme.length));
  return typeof reference === "string" ? reference : { vault, reference };
}

export function formatReference(ref: KeyRef, vaults: VaultKinds): string {
  return vaultKindOf(vaults, ref.kind).format(ref);
}

export function vaultName(ref: KeyRef, vaults: VaultKinds): string {
  return vaultKindOf(vaults, ref.kind).name;
}

export function vaultAccount(ref: KeyRef, vaults: VaultKinds): string {
  return vaultKindOf(vaults, ref.kind).account(ref);
}

export function vaultAccounts(refs: readonly KeyRef[], vaults: VaultKinds): string {
  return byKind(vaults)
    .flatMap((vault) => {
      const own = refs.filter((ref) => ref.kind === vault.kind);
      if (!own.length) return [];
      return vault.accounts?.(own) ?? [...new Set(own.map((ref) => vault.account(ref)))];
    })
    .join(" and ");
}

export function describeRef(ref: KeyRef, vaults: VaultKinds): string {
  return `${formatReference(ref, vaults)} (${vaultAccount(ref, vaults)})`;
}

export function sameAccount(a: KeyRef, b: KeyRef, vaults: VaultKinds): boolean {
  return vaultAccount(a, vaults) === vaultAccount(b, vaults);
}

export function sameItem(a: KeyRef, b: KeyRef, vaults: VaultKinds): boolean {
  return (
    a.kind === b.kind && sameAccount(a, b, vaults) && vaultKindOf(vaults, a.kind).sameItem(a, b)
  );
}

export function sameField(a: KeyRef, b: KeyRef, vaults: VaultKinds): boolean {
  return a.kind === b.kind && (vaultKindOf(vaults, a.kind).sameField?.(a, b) ?? true);
}

export function sameRef(a: KeyRef, b: KeyRef, vaults: VaultKinds): boolean {
  return sameItem(a, b, vaults) && sameField(a, b, vaults);
}

export function storedRef(value: unknown, vaults: VaultKinds): KeyRef | null {
  if (!isRecord(value)) return null;
  return vaults.find((vault) => vault.kind === value.kind)?.stored(value) ?? null;
}
