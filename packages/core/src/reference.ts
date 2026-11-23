import type { KeyRef } from "./contracts";
import type { VaultRules } from "./login";
import { isRecord } from "./record";

export function vaultKindOf<V extends VaultRules>(vaults: readonly V[], kind: string): V {
  const found = vaults.find((vault) => vault.kind === kind);
  if (!found) throw new Error(`keypin has no vault kind "${kind}"`);
  return found;
}

export function byKind<V extends VaultRules>(vaults: readonly V[]): V[] {
  return vaults.toSorted((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

export function referenceSchemes(vaults: readonly VaultRules[]): string {
  return byKind(vaults)
    .map((vault) => vault.scheme)
    .join(" or ");
}

export function parseReference<V extends VaultRules>(
  text: string,
  vaults: readonly V[],
): { vault: V; reference: KeyRef } | string {
  const query = /[?#].*$/s.exec(text)?.[0];
  if (query)
    return `can't have the query ${JSON.stringify(query)}; keypin reads the field's value as stored`;
  const vault = vaults.find((v) => text.startsWith(v.scheme));
  if (!vault) return `must start with ${referenceSchemes(vaults)}`;
  const reference = vault.parse(text.slice(vault.scheme.length));
  return typeof reference === "string" ? reference : { vault, reference };
}

export function formatReference(ref: KeyRef, vaults: readonly VaultRules[]): string {
  return vaultKindOf(vaults, ref.kind).format(ref);
}

export function vaultName(ref: KeyRef, vaults: readonly VaultRules[]): string {
  return vaultKindOf(vaults, ref.kind).name;
}

export function vaultAccount(ref: KeyRef, vaults: readonly VaultRules[]): string {
  return vaultKindOf(vaults, ref.kind).account(ref);
}

export function vaultAccounts(refs: readonly KeyRef[], vaults: readonly VaultRules[]): string {
  return byKind(vaults)
    .flatMap((vault) => {
      const own = refs.filter((ref) => ref.kind === vault.kind);
      if (!own.length) return [];
      return vault.accounts?.(own) ?? [...new Set(own.map((ref) => vault.account(ref)))];
    })
    .join(" and ");
}

export function describeRef(ref: KeyRef, vaults: readonly VaultRules[]): string {
  const vault = vaultKindOf(vaults, ref.kind);
  return `${vault.describe?.(ref) ?? vault.format(ref)} (${vaultAccount(ref, vaults)})`;
}

export function sameAccount(a: KeyRef, b: KeyRef, vaults: readonly VaultRules[]): boolean {
  return vaultAccount(a, vaults) === vaultAccount(b, vaults);
}

export function sameItem(a: KeyRef, b: KeyRef, vaults: readonly VaultRules[]): boolean {
  return (
    a.kind === b.kind && sameAccount(a, b, vaults) && vaultKindOf(vaults, a.kind).sameItem(a, b)
  );
}

export function sameField(a: KeyRef, b: KeyRef, vaults: readonly VaultRules[]): boolean {
  return a.kind === b.kind && (vaultKindOf(vaults, a.kind).sameField?.(a, b) ?? true);
}

export function sameRef(a: KeyRef, b: KeyRef, vaults: readonly VaultRules[]): boolean {
  return sameItem(a, b, vaults) && sameField(a, b, vaults);
}

export function mayShareField(a: KeyRef, b: KeyRef, vaults: readonly VaultRules[]): boolean {
  if (!sameItem(a, b, vaults)) return false;
  const vault = vaultKindOf(vaults, a.kind);
  return vault.mayShareField?.(a, b) ?? sameField(a, b, vaults);
}

export function storedRef(value: unknown, vaults: readonly VaultRules[]): KeyRef | null {
  if (!isRecord(value)) return null;
  return vaults.find((vault) => vault.kind === value.kind)?.stored(value) ?? null;
}
