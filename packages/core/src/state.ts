import type { Environment, KeyId, Receipt } from "./contracts";
import { type Files, readVersionedJson, writeJsonAtomic } from "./files";
import { receiptSecretKey } from "./map";
import { isRecord } from "./record";
import { storedRefWithPasswordDefault } from "./reference";
import type { Generation } from "./secret";

export const STATE_VERSION = 3;

export interface Operation {
  id: string;
  keyId: KeyId;
  environment: Environment;
  mapFile: string | null;
  generation: Generation;
  startedAt: string;
  planned: string[];
  done: string[];
}

export interface State {
  version: typeof STATE_VERSION;
  receipts: Receipt[];
  operations: Operation[];
}

export const emptyState = (): State => ({ version: STATE_VERSION, receipts: [], operations: [] });

export async function loadState(files: Files, path: string): Promise<State> {
  const data = await readVersionedJson(files, path, [1, 2, STATE_VERSION], "state file");
  if (!data) return emptyState();
  const mapFile = (r: Record<string, unknown>) =>
    data.version === STATE_VERSION ? r.mapFile : null;
  const receipts = Array.isArray(data.receipts)
    ? data.receipts.map((r: unknown) =>
        isRecord(r)
          ? {
              ...r,
              mapFile: mapFile(r),
              source: data.version === 1 ? null : storedSource(r.source),
            }
          : r,
      )
    : data.receipts;
  const operations = Array.isArray(data.operations)
    ? data.operations.map((o: unknown) => (isRecord(o) ? { ...o, mapFile: mapFile(o) } : o))
    : data.operations;
  if (!Array.isArray(receipts) || !receipts.every(isReceipt)) {
    throw new Error(`${path}: the state file's "receipts" must be a list of receipts`);
  }
  if (!Array.isArray(operations) || !operations.every(isOperation)) {
    throw new Error(`${path}: the state file's "operations" must be a list of operations`);
  }
  return { version: STATE_VERSION, receipts, operations };
}

export async function saveState(files: Files, path: string, state: State): Promise<void> {
  await writeJsonAtomic(files, path, state);
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

export function startOperation(state: State, operation: Omit<Operation, "done">): State {
  if (state.operations.some((o) => o.id === operation.id))
    throw new Error(`operation ${operation.id} already exists`);
  return { ...state, operations: [...state.operations, { ...operation, done: [] }] };
}

export function recordReceipt(state: State, receipt: Receipt, operationId?: string): State {
  const same = (r: Receipt) => receiptSecretKey(r) === receiptSecretKey(receipt);
  const operations = state.operations.map((o) =>
    o.id === operationId && !o.done.includes(receipt.destinationId)
      ? { ...o, done: [...o.done, receipt.destinationId] }
      : o,
  );
  return { ...state, receipts: [...state.receipts.filter((r) => !same(r)), receipt], operations };
}

export function finishOperation(state: State, operationId: string): State {
  return { ...state, operations: state.operations.filter((o) => o.id !== operationId) };
}

export function unfinishedOperations(state: State, owner: KeyOwner): Operation[] {
  return state.operations.filter((o) => ownedBy(o, owner));
}

const isText = (value: unknown) => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

function isReceipt(r: unknown): r is Receipt {
  return (
    isRecord(r) &&
    [r.keyId, r.environment, r.destinationId, r.generation, r.at].every(isText) &&
    isTextOrNull(r.mapFile) &&
    isRecord(r.account) &&
    isText(r.account.pinned) &&
    isText(r.account.publisher) &&
    isText(r.account.destinationAccount) &&
    (r.source === null || storedRefWithPasswordDefault(r.source) !== null) &&
    typeof r.evidence === "object" &&
    r.evidence !== null
  );
}

function storedSource(source: unknown): unknown {
  return source === null ? null : (storedRefWithPasswordDefault(source) ?? source);
}

function isOperation(o: unknown): o is Operation {
  return (
    isRecord(o) &&
    [o.id, o.keyId, o.environment, o.generation, o.startedAt].every(isText) &&
    isTextOrNull(o.mapFile) &&
    Array.isArray(o.planned) &&
    o.planned.every(isText) &&
    Array.isArray(o.done) &&
    o.done.every(isText)
  );
}
