import type { Environment, KeyId, KeyRef } from "./contracts";
import { envFlag } from "./map";
import { sameRef, storedRefWithPasswordDefault } from "./reference";
import { type Files, readVersionedJson, writeJsonAtomic } from "./files";
import { isRecord } from "./record";
import type { Generation } from "./secret";
import { type KeyOwner, ownedBy } from "./state";

export const ROTATIONS_VERSION = 2;

const ROTATION_STAGES = ["issuing", "issued", "stored", "published", "revoked"] as const;
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
  mapFile: string | null;
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
  const data = await readVersionedJson(files, path, [1, ROTATIONS_VERSION], "rotations file");
  if (!data) return emptyRotations();
  const rotations = Array.isArray(data.rotations)
    ? data.rotations.map((r: unknown) =>
        isRecord(r)
          ? {
              ...r,
              mapFile: data.version === ROTATIONS_VERSION ? r.mapFile : null,
              item: storedRefWithPasswordDefault(r.item) ?? r.item,
            }
          : r,
      )
    : data.rotations;
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
  owner: KeyOwner,
  item: KeyRef,
): Rotation | undefined {
  return data.rotations.find(
    (r) => ownedBy(r, owner) && sameRef(r.item, item) && r.stage !== "revoked",
  );
}

export function rotateCommand(
  keyId: KeyId,
  environment: Environment,
  fallback: Environment,
): string {
  return `keypin rotate ${keyId}${envFlag(environment, fallback)}`;
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
    isTextOrNull(r.mapFile) &&
    ROTATION_STAGES.some((stage) => stage === r.stage) &&
    storedRefWithPasswordDefault(r.item) !== null &&
    isTokenRecord(r.old) &&
    isTokenRecord(r.new)
  );
}
