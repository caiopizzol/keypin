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

export interface ItemIds {
  vault: string;
  item: string;
}

export interface VaultBackend {
  readonly capabilities: VaultCapabilities;
  read(ref: KeyRef): Promise<Secret>;
  readItem(ref: KeyRef): Promise<{ secret: Secret; ids: ItemIds }>;
  itemIds(ref: KeyRef): Promise<ItemIds>;
  write(
    ref: KeyRef,
    secret: Secret,
    options?: { rotated?: string; newItem?: boolean },
  ): Promise<void>;
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
  fix?: string;
}

export type Evidence = Readonly<Record<string, string | number | boolean | null>>;

export interface Destination {
  readonly capabilities: DestinationCapabilities;
  describe(): string;
  checkAccount(): Promise<AccountCheck>;
  write(name: string, secret: Secret): Promise<Evidence>;
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
