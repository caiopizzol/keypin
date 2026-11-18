import type { Issuer, KeyId, KeyRef } from "./contracts";
import type { TableReader } from "./destination";
import type { Fetch } from "./fetch";
import type { Secret } from "./secret";

export interface IssuerSpec {
  readonly kind: string;
  readonly admin?: KeyRef;
}

export interface IssuerReader extends TableReader {
  admin(): KeyRef | undefined;
  idKey(): KeyId | undefined;
}

interface IssuerKindBase<T extends IssuerSpec> {
  readonly kind: T["kind"];
  parse(read: IssuerReader): T | undefined;
  claims?(spec: T): readonly string[];
  idKey?(spec: T): KeyId;
  refuses?(keyName: KeyId): string | undefined;
}

export type IssuerKind<T extends IssuerSpec = IssuerSpec> = IssuerKindBase<T> &
  (
    | { readonly admin?: true; connect(spec: T, admin: Secret, fetch?: Fetch): Issuer }
    | { readonly admin: false; connect(spec: T): Issuer }
  );

export type IssuerKinds = readonly IssuerKind[];

function issuerKindOf(kinds: IssuerKinds, kind: string): IssuerKind {
  const found = kinds.find((k) => k.kind === kind);
  if (!found) throw new Error(`keypin has no issuer kind "${kind}"`);
  return found;
}

export function connectIssuer(
  kinds: IssuerKinds,
  spec: IssuerSpec,
  admin: Secret | null,
  fetch?: Fetch,
): Issuer {
  const found = issuerKindOf(kinds, spec.kind);
  if (found.admin === false) return found.connect(spec);
  if (admin === null) throw new Error(`the "${spec.kind}" issuer needs an admin key`);
  return found.connect(spec, admin, fetch);
}

export function idKeyOf(kinds: IssuerKinds, spec: IssuerSpec): KeyId | null {
  return kinds.find((k) => k.kind === spec.kind)?.idKey?.(spec) ?? null;
}
