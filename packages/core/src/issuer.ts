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

export interface IssuerRules<T extends IssuerSpec = IssuerSpec> {
  readonly kind: T["kind"];
  readonly admin?: boolean;
  parse(read: IssuerReader): T | undefined;
  claims?(spec: T): readonly string[];
  idKey?(spec: T): KeyId;
  refuses?(keyName: KeyId): string | undefined;
}

export type IssuerKind<T extends IssuerSpec = IssuerSpec> = IssuerRules<T> &
  (
    | {
        readonly admin?: true;
        readonly adminExpiry?: true;
        connect(spec: T, admin: Secret, fetch?: Fetch): Issuer;
      }
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

export function readsAdminExpiry(kinds: IssuerKinds, spec: IssuerSpec): boolean {
  const found = kinds.find((k) => k.kind === spec.kind);
  return found !== undefined && found.admin !== false && found.adminExpiry === true;
}

export function idKeyOf(kinds: readonly IssuerRules[], spec: IssuerSpec): KeyId | null {
  return kinds.find((k) => k.kind === spec.kind)?.idKey?.(spec) ?? null;
}

export function fitKeyName(
  name: string,
  limit: number,
  normalize: (name: string) => string = (same) => same,
): string {
  if (normalize(name).length <= limit) return normalize(name);
  const kept = [2, 1]
    .map((count) => name.split(" ").slice(1).slice(-count).join(" "))
    .find((end) => end && end.length < limit / 2);
  const end = kept ? ` ${kept}` : "";
  for (let room = limit - end.length - 1; room >= 0; room--) {
    const start = name
      .slice(0, room)
      .replace(/[\uD800-\uDBFF]$/, "")
      .trimEnd();
    const fitted = normalize(`${start}…${end}`);
    if (fitted.length <= limit) return fitted;
  }
  return normalize(end.trimStart());
}
