import type { Environment, KeyId, Receipt } from "./contracts";
import { type Files, readVersionedJson, writeJsonAtomic } from "./files";
import { type DestinationKinds, receiptSecretKey } from "./destination";
import { isRecord } from "./record";
import type { VaultKinds } from "./login";
import { storedRef } from "./reference";
import type { Generation } from "./secret";

const STATE_VERSION = 5;

export interface Issued {
  keyId: KeyId;
  environment: Environment;
  mapFile: string;
  issuer: string;
  id: string;
  generation: Generation;
  at: string;
  old: { id: string | null; generation: Generation; revoked: boolean };
  held?: boolean;
  idKey?: KeyId;
}

export interface State {
  version: typeof STATE_VERSION;
  receipts: Receipt[];
  issued: Issued[];
}

export const emptyState = (): State => ({
  version: STATE_VERSION,
  receipts: [],
  issued: [],
});

export async function loadState(files: Files, path: string, vaults: VaultKinds): Promise<State> {
  const data = await readVersionedJson(files, path, [1, 2, 3, 4, STATE_VERSION], "state file");
  if (!data) return emptyState();
  const version = Number(data.version);
  const mapFile = (r: Record<string, unknown>) => (version >= 3 ? r.mapFile : null);
  const receipts = Array.isArray(data.receipts)
    ? data.receipts.map((r: unknown) =>
        isRecord(r)
          ? {
              ...r,
              mapFile: mapFile(r),
              source: version === 1 ? null : storedSource(r.source, vaults),
              sourceIds: version >= 4 ? r.sourceIds : null,
            }
          : r,
      )
    : data.receipts;
  if (!Array.isArray(receipts) || !receipts.every((r) => isReceipt(r, vaults))) {
    throw new Error(`${path}: the state file's "receipts" must be a list of receipts`);
  }
  const issued = version >= 5 ? data.issued : [];
  if (!Array.isArray(issued) || !issued.every(isIssued)) {
    throw new Error(`${path}: the state file's "issued" must be a list of issued keys`);
  }
  return { version: STATE_VERSION, receipts, issued };
}

export async function saveState(files: Files, path: string, state: State): Promise<void> {
  await writeJsonAtomic(files, path, { ...state, operations: [] });
}

export interface KeyOwner {
  keyId: KeyId;
  environment: Environment;
  mapFile: string;
}

export function ownedBy(
  entry: { keyId: KeyId; environment: Environment; mapFile: string | null },
  owner: KeyOwner,
): boolean {
  return (
    entry.mapFile === owner.mapFile &&
    entry.keyId === owner.keyId &&
    entry.environment === owner.environment
  );
}

export function receiptsFor(state: State, owner: KeyOwner): Receipt[] {
  return state.receipts.filter((r) => ownedBy(r, owner));
}

export function recordReceipt(state: State, receipt: Receipt, kinds: DestinationKinds): State {
  const key = receiptSecretKey(receipt, kinds);
  const same = (r: Receipt) => receiptSecretKey(r, kinds) === key;
  return { ...state, receipts: [...state.receipts.filter((r) => !same(r)), receipt] };
}

export function issuedFor(state: State, owner: KeyOwner): Issued | undefined {
  return state.issued.find((i) => ownedBy(i, owner));
}

export function recordIssued(state: State, issued: Issued): State {
  return { ...state, issued: [...state.issued.filter((i) => !ownedBy(i, issued)), issued] };
}

export type NextRotation =
  | { action: "resume"; issued: Issued }
  | { action: "wait"; issued: Issued }
  | { action: "create"; current: string | null; abandoned: Issued | null };

export function nextRotation(input: {
  issued: Issued | undefined;
  issuer: string;
  generation: Generation;
  published: boolean;
  idSaved?: boolean;
}): NextRotation {
  const { issued, issuer, generation, published, idSaved = true } = input;
  if (!issued) return { action: "create", current: null, abandoned: null };
  if (issued.issuer !== issuer) return { action: "create", current: null, abandoned: issued };
  if (issued.generation === generation) {
    const revokeLeft = issued.old.id !== null && !issued.old.revoked;
    return !published || revokeLeft || !idSaved
      ? { action: "resume", issued }
      : { action: "create", current: issued.id, abandoned: null };
  }
  if (issued.held && issued.old.generation === generation) return { action: "wait", issued };
  if (issued.old.generation === generation)
    return { action: "create", current: issued.old.id, abandoned: issued };
  return { action: "create", current: null, abandoned: issued };
}

const isText = (value: unknown) => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

function isReceipt(r: unknown, vaults: VaultKinds): r is Receipt {
  return (
    isRecord(r) &&
    [r.keyId, r.environment, r.destinationId, r.generation, r.at].every(isText) &&
    isTextOrNull(r.mapFile) &&
    isRecord(r.account) &&
    isText(r.account.pinned) &&
    isText(r.account.publisher) &&
    isText(r.account.destinationAccount) &&
    (r.source === null || storedRef(r.source, vaults) !== null) &&
    (r.sourceIds === null ||
      (isRecord(r.sourceIds) && isText(r.sourceIds.vault) && isText(r.sourceIds.item))) &&
    typeof r.evidence === "object" &&
    r.evidence !== null
  );
}

function storedSource(source: unknown, vaults: VaultKinds): unknown {
  return source === null ? null : (storedRef(source, vaults) ?? source);
}

function isIssued(i: unknown): i is Issued {
  return (
    isRecord(i) &&
    [i.keyId, i.environment, i.mapFile, i.issuer, i.id, i.generation, i.at].every(isText) &&
    isRecord(i.old) &&
    isTextOrNull(i.old.id) &&
    isText(i.old.generation) &&
    typeof i.old.revoked === "boolean" &&
    (i.held === undefined || typeof i.held === "boolean") &&
    (i.idKey === undefined || isText(i.idKey))
  );
}
