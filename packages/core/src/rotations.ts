import type { Environment, KeyId, KeyRef } from "./contracts";
import { sameRef } from "./plan";
import { type Files, readVersionedJson, writeJsonAtomic } from "./files";
import { isRecord } from "./record";
import type { Generation } from "./secret";

export const ROTATIONS_VERSION = 1;

export const ROTATION_STAGES = ["issuing", "issued", "stored", "published", "revoked"] as const;
export type RotationStage = (typeof ROTATION_STAGES)[number];

export interface TokenRecord {
  id: string | null;
  name: string;
  expiresOn: string | null;
  generation: Generation | null;
}

export interface Rotation {
  id: string;
  keyId: KeyId;
  environment: Environment;
  item: KeyRef;
  provider: string;
  account: string;
  stage: RotationStage;
  startedAt: string;
  updatedAt: string;
  old: TokenRecord;
  new: TokenRecord;
}

export interface Rotations {
  version: typeof ROTATIONS_VERSION;
  rotations: Rotation[];
}

export const emptyRotations = (): Rotations => ({ version: ROTATIONS_VERSION, rotations: [] });

export async function loadRotations(files: Files, path: string): Promise<Rotations> {
  const data = await readVersionedJson(files, path, [ROTATIONS_VERSION], "rotations file");
  if (!data) return emptyRotations();
  const { rotations } = data;
  if (!Array.isArray(rotations) || !rotations.every(isRotation)) {
    throw new Error(`${path}: the rotations file's "rotations" must be a list of rotations`);
  }
  return { version: ROTATIONS_VERSION, rotations };
}

export async function saveRotations(files: Files, path: string, data: Rotations): Promise<void> {
  await writeJsonAtomic(files, path, data);
}

export function unfinishedRotation(
  data: Rotations,
  keyId: KeyId,
  environment: Environment,
  item: KeyRef,
): Rotation | undefined {
  return data.rotations.find(
    (r) =>
      r.keyId === keyId &&
      r.environment === environment &&
      sameRef(r.item, item) &&
      r.stage !== "revoked",
  );
}

export function rotateCommand(keyId: KeyId, environment: Environment): string {
  return `keypin rotate ${keyId}${environment === "prod" ? "" : ` --env ${environment}`}`;
}

export function putRotation(data: Rotations, rotation: Rotation): Rotations {
  return {
    ...data,
    rotations: [...data.rotations.filter((r) => r.id !== rotation.id), rotation],
  };
}

export function dropRotation(data: Rotations, id: string): Rotations {
  return { ...data, rotations: data.rotations.filter((r) => r.id !== id) };
}

const isText = (value: unknown) => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

function isTokenRecord(t: unknown): t is TokenRecord {
  return isRecord(t) && isText(t.name) && [t.id, t.expiresOn, t.generation].every(isTextOrNull);
}

function isRotation(r: unknown): r is Rotation {
  return (
    isRecord(r) &&
    [r.id, r.keyId, r.environment, r.provider, r.account, r.startedAt, r.updatedAt].every(isText) &&
    ROTATION_STAGES.some((stage) => stage === r.stage) &&
    isRecord(r.item) &&
    r.item.kind === "1password" &&
    [r.item.account, r.item.vault, r.item.item].every(isText) &&
    isTokenRecord(r.old) &&
    isTokenRecord(r.new)
  );
}
