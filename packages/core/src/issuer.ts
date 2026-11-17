import type { Issuer, KeyId, KeyRef } from "./contracts";
import type { TableReader } from "./destination";
import type { Fetch } from "./fetch";
import type { Secret } from "./secret";

export interface IssuerSpec {
  readonly kind: string;
  readonly admin: KeyRef;
}

export interface IssuerReader extends TableReader {
  admin(): KeyRef | undefined;
  idKey(): KeyId | undefined;
}

export interface IssuerKind<T extends IssuerSpec = IssuerSpec> {
  readonly kind: T["kind"];
  parse(read: IssuerReader): T | undefined;
  connect(spec: T, admin: Secret, fetch?: Fetch): Issuer;
  claims?(spec: T): readonly string[];
  idKey?(spec: T): KeyId;
}

export type IssuerKinds = readonly IssuerKind[];

function issuerKindOf(kinds: IssuerKinds, kind: string): IssuerKind {
  const found = kinds.find((k) => k.kind === kind);
  if (!found) throw new Error(`keypin has no issuer kind "${kind}"`);
  return found;
}

export function connectIssuer(
  kinds: IssuerKinds,
  spec: IssuerSpec,
  admin: Secret,
  fetch?: Fetch,
): Issuer {
  return issuerKindOf(kinds, spec.kind).connect(spec, admin, fetch);
}

export function idKeyOf(kinds: IssuerKinds, spec: IssuerSpec): KeyId | null {
  return kinds.find((k) => k.kind === spec.kind)?.idKey?.(spec) ?? null;
}
