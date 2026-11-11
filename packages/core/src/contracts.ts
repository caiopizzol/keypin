import type { Generation, Secret } from "./secret";

export type KeyId = string;

export type Environment = string;
export const DEFAULT_ENVIRONMENTS: readonly Environment[] = ["dev", "prod"];

export interface KeyRef {
  kind: "1password";
  account: string;
  vault: string;
  item: string;
  section: string | null;
  field: string;
}

export interface VaultScope {
  kind: "1password";
  account: string;
  vault: string;
}

export interface VaultCapabilities {
  read: boolean;
  write: boolean;
  list: boolean;
  metadata: boolean;
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

export interface VaultBackend {
  readonly capabilities: VaultCapabilities;
  read(ref: KeyRef): Promise<Secret>;
  write(ref: KeyRef, secret: Secret, options?: { rotated?: string }): Promise<void>;
  list(scope: VaultScope): Promise<VaultItem[]>;
  metadata(ref: KeyRef): Promise<VaultMetadata>;
}

export interface DestinationCapabilities {
  write: boolean;
  accountCheck: boolean;
  evidence: boolean;
}

export interface AccountCheck {
  publisher: string;
  destinationAccount: string | null;
  expected: string;
  ok: boolean;
  reason?: string;
}

export type Evidence = Readonly<Record<string, string | number | boolean | null>>;

export interface Destination {
  readonly capabilities: DestinationCapabilities;
  describe(): string;
  checkAccount(): Promise<AccountCheck>;
  write(name: string, secret: Secret): Promise<Evidence>;
}

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export interface TokenPolicy {
  effect: string;
  resources: { readonly [key: string]: Json };
  permissionGroups: { id: string; name: string }[];
}

export interface ProviderToken {
  id: string;
  name: string;
  status: string;
  expiresOn: string | null;
  lastUsedOn: string | null;
  policies: TokenPolicy[];
  condition: { readonly [key: string]: Json } | null;
}

export interface VerifiedToken {
  id: string;
  status: string;
  expiresOn: string | null;
}

export interface TokenProvider {
  describe(): string;
  verify(secret: Secret): Promise<VerifiedToken>;
  details(id: string): Promise<ProviderToken | null>;
  issue(request: {
    name: string;
    like: ProviderToken;
    expiresOn: string;
  }): Promise<{ token: ProviderToken; value: Secret } | { refused: string }>;
  revoke(id: string): Promise<"revoked" | "already gone">;
}

export interface Receipt {
  keyId: KeyId;
  environment: Environment;
  mapFile: string | null;
  source: KeyRef | null;
  destinationId: string;
  generation: Generation;
  account: { pinned: string; publisher: string; destinationAccount: string };
  at: string;
  evidence: Evidence;
}
