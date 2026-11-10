import type { Environment, KeyId, KeyRef, Receipt } from "./contracts";
import { type Files, readVersionedJson, writeJsonAtomic } from "./files";
import { receiptSecretKey } from "./map";
import { isRecord } from "./record";
import type { Generation } from "./secret";

export const STATE_VERSION = 2;

export interface Operation {
  id: string;
  keyId: KeyId;
  environment: Environment;
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
  const data = await readVersionedJson(files, path, [1, STATE_VERSION], "state file");
  if (!data) return emptyState();
  const { operations } = data;
  const receipts = Array.isArray(data.receipts)
    ? data.receipts.map((r: unknown) =>
        data.version === 1 && isRecord(r) ? { ...r, source: null } : r,
      )
    : data.receipts;
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

export function receiptsFor(state: State, keyId: KeyId, environment: Environment): Receipt[] {
  return state.receipts.filter((r) => r.keyId === keyId && r.environment === environment);
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

export function unfinishedOperations(
  state: State,
  keyId: KeyId,
  environment: Environment,
): Operation[] {
  return state.operations.filter((o) => o.keyId === keyId && o.environment === environment);
}

const isText = (value: unknown) => typeof value === "string";

function isReceipt(r: unknown): r is Receipt {
  return (
    isRecord(r) &&
    [r.keyId, r.environment, r.destinationId, r.generation, r.at].every(isText) &&
    isRecord(r.account) &&
    isText(r.account.pinned) &&
    isText(r.account.publisher) &&
    isText(r.account.destinationAccount) &&
    (r.source === null || isKeyRef(r.source)) &&
    typeof r.evidence === "object" &&
    r.evidence !== null
  );
}

function isKeyRef(ref: unknown): ref is KeyRef {
  return (
    isRecord(ref) && ref.kind === "1password" && [ref.account, ref.vault, ref.item].every(isText)
  );
}

function isOperation(o: unknown): o is Operation {
  return (
    isRecord(o) &&
    [o.id, o.keyId, o.environment, o.generation, o.startedAt].every(isText) &&
    Array.isArray(o.planned) &&
    o.planned.every(isText) &&
    Array.isArray(o.done) &&
    o.done.every(isText)
  );
}
