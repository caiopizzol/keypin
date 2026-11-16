import type { Generation, Secret } from "./secret";

export type KeyId = string;

export type Environment = string;
export const DEFAULT_ENVIRONMENTS: readonly Environment[] = ["dev", "prod"];

export interface KeyRef {
  readonly kind: string;
  readonly [field: string]: unknown;
}

export interface VaultScope {
  readonly kind: string;
  readonly [field: string]: unknown;
}

export interface VaultItem {
  id: string;
  title: string;
  tags: string[];
  updatedAt: string;
}

export interface VaultMetadata {
  rotated: string | null;
}

export interface ItemIds {
  vault: string;
  item: string;
}

export class HeldForApproval extends Error {}

export class WriteRefused extends Error {}

export class NothingChanged extends Error {}

export type SignInReason =
  | { kind: "no-credentials" }
  | { kind: "no-desktop-app" }
  | { kind: "sandboxed-desktop-app" }
  | { kind: "unknown-account" }
  | { kind: "wrong-account"; pinned: string; actual: string }
  | { kind: "other" };

export class SignInFailed extends Error {
  readonly reason: SignInReason;

  constructor(message: string, reason: SignInReason) {
    super(message);
    this.reason = reason;
  }
}

export interface VaultBackend {
  read(ref: KeyRef): Promise<Secret>;
  readItem(ref: KeyRef): Promise<{ secret: Secret; ids: ItemIds }>;
  itemIds(ref: KeyRef): Promise<ItemIds>;
  write(
    ref: KeyRef,
    secret: Secret,
    options?: { rotated?: string; newItem?: boolean },
  ): Promise<void>;
  checkWrite?(ref: KeyRef): Promise<void>;
  list(scope: VaultScope): Promise<VaultItem[]>;
  metadata(ref: KeyRef): Promise<VaultMetadata>;
}

export interface AccountCheck {
  publisher: string;
  destinationAccount: string | null;
  expected: string;
  ok: boolean;
  reason?: string;
  fix?: string;
}

export type Evidence = Readonly<Record<string, string | number | boolean | null>>;

export interface Destination {
  describe(): string;
  checkAccount(): Promise<AccountCheck>;
  write(name: string, secret: Secret): Promise<Evidence>;
  writeMany?(secrets: readonly { name: string; secret: Secret }[]): Promise<Evidence>;
}

export interface IssuerCheck {
  ok: boolean;
  facts: string;
  reason?: string;
  fix?: string;
  currentId?: string;
  gone?: string;
  notes?: { create?: string; revoke?: string };
}

export interface IssuedKey {
  id: string;
  secret: Secret;
}

export interface Issuer {
  describe(): string;
  dashboard(): string;
  checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck>;
  create(name: string): Promise<IssuedKey>;
  lostCreate?(name: string): string;
  revoke(id: string): Promise<"revoked" | "already gone">;
}

export interface Receipt {
  keyId: KeyId;
  environment: Environment;
  mapFile: string | null;
  source: KeyRef | null;
  sourceIds: ItemIds | null;
  destinationId: string;
  generation: Generation;
  account: { pinned: string; publisher: string; destinationAccount: string };
  at: string;
  evidence: Evidence;
}
