import type { Environment, ItemIds, KeyId, KeyRef, Receipt } from "./contracts";
import {
  type DestinationKinds,
  placeId,
  type PublishTarget,
  receiptSecretKey,
  secretKey,
} from "./destination";
import { type Files, readVersionedJson, writeJsonAtomic } from "./files";
import { type EnvEntry, type KeysMap, pairedWith } from "./map";
import { latestPerSecret } from "./plan";
import { isRecord } from "./record";
import { type Generation, hashText } from "./secret";
import {
  type Issued,
  issuedFor,
  isProof,
  type KeyOwner,
  type Proof,
  recordIssued,
  type State,
} from "./state";

const ROTATION_FILE_VERSION = 1;

interface CommittedIssued {
  key: KeyId;
  environment: Environment;
  issuer: string;
  id: string;
  generation: Generation;
  at: string;
  old: { id: string | null; generation: Generation; revoked: boolean };
  held?: true;
  unsaved?: true;
  proof?: Proof;
}

export interface CommittedWrite {
  key: KeyId;
  environment: Environment;
  destination: string;
  account: string;
  generation: Generation;
  at: string;
  approved: string;
}

export interface RotationFile {
  version: typeof ROTATION_FILE_VERSION;
  issued: CommittedIssued[];
  published: CommittedWrite[];
}

export interface RotationRecord {
  at: string;
  published: string[];
  unpublished: string[];
  old: "revoked" | "waiting for approval" | "still in use" | "unknown";
}

export function rotates(map: KeysMap, keyId: KeyId, environment: Environment): EnvEntry | null {
  const entry = map.keys.find((k) => k.name === keyId)?.environments[environment];
  if (!entry?.issuer || entry.idKey !== undefined || pairedWith(map, keyId, environment))
    return null;
  return entry;
}

export function removedBehind(
  file: RotationFile | null,
  map: KeysMap,
  kinds: DestinationKinds,
  owner: KeyOwner,
  generation: Generation,
): CommittedWrite[] {
  const listed = rotates(map, owner.keyId, owner.environment)?.publish ?? [];
  return (file?.published ?? []).filter(
    (p) =>
      p.key === owner.keyId &&
      p.environment === owner.environment &&
      p.generation !== generation &&
      !listed.some((target) => secretKey(target, owner.keyId, kinds) === committedSecret(p, kinds)),
  );
}

export function waitsForRevoke(issued: Issued | undefined): issued is Issued {
  return issued !== undefined && issued.old.id !== null && !issued.old.revoked;
}

export function deliveredTo(
  file: RotationFile | null,
  receipts: readonly Receipt[],
  owner: KeyOwner,
  target: PublishTarget,
  generation: Generation,
  kinds: DestinationKinds,
): boolean {
  const secret = secretKey(target, owner.keyId, kinds);
  const same = (
    key: KeyId,
    environment: Environment,
    place: string,
    account: string,
    made: Generation,
  ) =>
    key === owner.keyId &&
    environment === owner.environment &&
    place === secret &&
    account === target.account &&
    made === generation;
  return (
    (file?.published ?? []).some((p) =>
      same(p.key, p.environment, committedSecret(p, kinds), p.account, p.generation),
    ) ||
    receipts.some(
      (r) =>
        r.mapFile === owner.mapFile &&
        same(r.keyId, r.environment, receiptSecretKey(r, kinds), r.account.pinned, r.generation),
    )
  );
}

function committedSecret(write: CommittedWrite, kinds: DestinationKinds): string {
  return receiptSecretKey(
    { destinationId: write.destination, account: { pinned: write.account } },
    kinds,
  );
}

function approvalPrint(input: {
  secret: string;
  account: string;
  ref: KeyRef;
  ids: ItemIds;
}): Promise<string> {
  const ref = Object.keys(input.ref)
    .toSorted()
    .map((field) => [field, input.ref[field]]);
  return hashText(
    JSON.stringify([input.secret, input.account, ref, input.ids.vault, input.ids.item]),
  );
}

export async function rotationFile(
  state: State,
  map: KeysMap,
  kinds: DestinationKinds,
  base: RotationFile | null,
): Promise<RotationFile> {
  const listed = (key: KeyId, environment: Environment, secret: string) =>
    rotates(map, key, environment)?.publish.some(
      (target) => secretKey(target, key, kinds) === secret,
    ) === true;
  const issued = merged(
    (base?.issued ?? []).filter((c) => rotates(map, c.key, c.environment)),
    state.issued
      .filter((i) => i.mapFile === map.file && rotates(map, i.keyId, i.environment))
      .map(committedIssued),
    (c) => [c.key, c.environment],
    mergeIssued,
  );
  const stillWorks = (c: CommittedWrite) => {
    const now = issued.find((i) => i.key === c.key && i.environment === c.environment);
    if (!now || c.generation === now.generation) return true;
    return c.generation === now.old.generation && !now.old.revoked;
  };
  const kept = (c: CommittedWrite) =>
    listed(c.key, c.environment, committedSecret(c, kinds)) ||
    (rotates(map, c.key, c.environment) !== null && stillWorks(c));
  const published: CommittedWrite[] = [];
  for (const receipt of latestPerSecret(state.receipts, kinds)) {
    const { keyId, environment, source, sourceIds } = receipt;
    if (receipt.mapFile !== map.file || !source || !sourceIds) continue;
    published.push({
      key: keyId,
      environment,
      destination: receipt.destinationId,
      account: receipt.account.pinned,
      generation: receipt.generation,
      at: receipt.at,
      approved: await approvalPrint({
        secret: receiptSecretKey(receipt, kinds),
        account: receipt.account.pinned,
        ref: source,
        ids: sourceIds,
      }),
    });
  }
  return {
    version: ROTATION_FILE_VERSION,
    issued,
    published: merged(
      (base?.published ?? []).filter(kept),
      published.filter(kept),
      (c) => [c.key, c.environment, committedSecret(c, kinds)],
      (older, newer) => (newer.at >= older.at ? newer : older),
    ),
  };
}

function merged<T>(
  base: readonly T[],
  next: readonly T[],
  id: (item: T) => string[],
  pick: (older: T, newer: T) => T,
): T[] {
  const all = new Map<string, T>();
  const key = (item: T) => JSON.stringify(id(item));
  for (const item of base) all.set(key(item), item);
  for (const item of next) {
    const seen = all.get(key(item));
    all.set(key(item), seen ? pick(seen, item) : item);
  }
  return [...all.keys()].toSorted().flatMap((k) => all.get(k) ?? []);
}

function mergeIssued(older: CommittedIssued, newer: CommittedIssued): CommittedIssued {
  if (older.id !== newer.id || older.at !== newer.at) return newer.at >= older.at ? newer : older;
  return { ...newer, old: { ...newer.old, revoked: older.old.revoked || newer.old.revoked } };
}

function committedIssued(i: Issued): CommittedIssued {
  return {
    key: i.keyId,
    environment: i.environment,
    issuer: i.issuer,
    id: i.id,
    generation: i.generation,
    at: i.at,
    old: { id: i.old.id, generation: i.old.generation, revoked: i.old.revoked },
    ...(i.held ? { held: true } : {}),
    ...(i.unsaved ? { unsaved: true } : {}),
    ...(i.proof ? { proof: { new: i.proof.new, old: i.proof.old } } : {}),
  };
}

export function restoreIssued(state: State, file: RotationFile | null, map: KeysMap): State {
  let restored = state;
  for (const c of file?.issued ?? []) {
    if (!rotates(map, c.key, c.environment)) continue;
    const owner = { keyId: c.key, environment: c.environment, mapFile: map.file };
    const local = issuedFor(restored, owner);
    const { key: _key, environment: _environment, ...rest } = c;
    if (!local || local.at < c.at) restored = recordIssued(restored, { ...owner, ...rest });
    else if (local.id === c.id && local.at === c.at && c.old.revoked && !local.old.revoked)
      restored = recordIssued(restored, { ...local, old: { ...local.old, revoked: true } });
  }
  return restored;
}

export async function restoreReceipts(input: {
  state: State;
  file: RotationFile | null;
  map: KeysMap;
  kinds: DestinationKinds;
  owner: KeyOwner;
  ids: () => Promise<ItemIds>;
}): Promise<State> {
  const { state, file, map, kinds, owner } = input;
  const entry = rotates(map, owner.keyId, owner.environment);
  if (!entry || !file) return state;
  const latest = new Map(
    latestPerSecret(state.receipts, kinds).map((r) => [receiptSecretKey(r, kinds), r]),
  );
  const newer = file.published.flatMap((c) => {
    if (c.key !== owner.keyId || c.environment !== owner.environment) return [];
    const secret = committedSecret(c, kinds);
    const target = entry.publish.find((t) => secretKey(t, c.key, kinds) === secret);
    if (!target) return [];
    const local = latest.get(secret);
    return local && local.at >= c.at ? [] : [{ c, target, secret }];
  });
  if (!newer.length) return state;
  const ids = await input.ids();
  const restored: Receipt[] = [];
  for (const { c, target, secret } of newer) {
    const print = await approvalPrint({ secret, account: target.account, ref: entry.ref, ids });
    if (print !== c.approved) continue;
    restored.push({
      ...owner,
      source: entry.ref,
      sourceIds: ids,
      destinationId: c.destination,
      generation: c.generation,
      account: { pinned: target.account, publisher: "unknown", destinationAccount: "unknown" },
      at: c.at,
      evidence: {},
    });
  }
  return restored.length ? { ...state, receipts: [...state.receipts, ...restored] } : state;
}

export function rotationRecord(
  file: RotationFile,
  map: KeysMap,
  kinds: DestinationKinds,
  keyId: KeyId,
  environment: Environment,
): RotationRecord | null {
  const entry = rotates(map, keyId, environment);
  const issued = file.issued.find((i) => i.key === keyId && i.environment === environment);
  if (!entry || !issued) return null;
  const owner = { keyId, environment, mapFile: map.file };
  const got = entry.publish.map((target) => ({
    place: placeId(target, kinds),
    done: deliveredTo(file, [], owner, target, issued.generation, kinds),
  }));
  const unpublished = got.filter((g) => !g.done).map((g) => g.place);
  return {
    at: issued.at,
    published: got.filter((g) => g.done).map((g) => g.place),
    unpublished,
    old: issued.old.revoked
      ? "revoked"
      : issued.old.id === null
        ? "unknown"
        : unpublished.length
          ? "still in use"
          : "waiting for approval",
  };
}

export async function loadRotationFile(files: Files, path: string): Promise<RotationFile | null> {
  const data = await readVersionedJson(files, path, [ROTATION_FILE_VERSION], "rotation file");
  if (!data) return null;
  const issued = Array.isArray(data.issued) ? data.issued.map(readIssued) : [null];
  const published = Array.isArray(data.published) ? data.published.map(readWrite) : [null];
  const all = <T>(list: (T | null)[]): list is T[] => list.every((item) => item !== null);
  if (!all(issued))
    throw new Error(`${path}: the rotation file's "issued" must be a list of issued keys`);
  if (!all(published))
    throw new Error(`${path}: the rotation file's "published" must be a list of writes`);
  return { version: ROTATION_FILE_VERSION, issued, published };
}

export async function writeRotationFile(
  files: Files,
  path: string,
  file: RotationFile,
): Promise<"written" | "unchanged"> {
  const text = await files.read(path);
  const empty = !file.issued.length && !file.published.length;
  if ((text === null && empty) || text === `${JSON.stringify(file, null, 2)}\n`) return "unchanged";
  await writeJsonAtomic(files, path, file);
  return "written";
}

const isText = (value: unknown): value is string => typeof value === "string";

function readIssued(value: unknown): CommittedIssued | null {
  if (!isRecord(value) || !isRecord(value.old)) return null;
  const { key, environment, issuer, id, generation, at, held, unsaved, proof } = value;
  const { id: oldId, generation: oldGeneration, revoked } = value.old;
  if (!isText(key) || !isText(environment) || !isText(issuer) || !isText(id)) return null;
  if (!isText(generation) || !isText(at) || !isText(oldGeneration)) return null;
  if (!(oldId === null || isText(oldId)) || typeof revoked !== "boolean") return null;
  if ((held !== undefined && held !== true) || (unsaved !== undefined && unsaved !== true))
    return null;
  if (proof !== undefined && !isProof(proof)) return null;
  const old = { id: oldId, generation: oldGeneration, revoked };
  const flags = {
    ...(held ? { held: true as const } : {}),
    ...(unsaved ? { unsaved: true as const } : {}),
    ...(proof === undefined ? {} : { proof: { new: proof.new, old: proof.old } }),
  };
  return { key, environment, issuer, id, generation, at, old, ...flags };
}

function readWrite(value: unknown): CommittedWrite | null {
  if (!isRecord(value)) return null;
  const { key, environment, destination, account, generation, at, approved } = value;
  if (!isText(key) || !isText(environment) || !isText(destination) || !isText(account)) return null;
  if (!isText(generation) || !isText(at) || !isText(approved)) return null;
  return { key, environment, destination, account, generation, at, approved };
}
