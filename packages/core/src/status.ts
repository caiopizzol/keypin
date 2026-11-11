import type { Environment, KeyId, KeyRef, Receipt, VaultMetadata } from "./contracts";
import {
  destinationId,
  type MapResult,
  publishEnvironment,
  receiptSecretKey,
  secretKey,
} from "./map";
import { latestPerSecret } from "./plan";
import { sameRef } from "./reference";
import type { Registry } from "./registry";
import { type Rotation, ROTATIONS_VERSION, rotateCommand, unfinishedRotation } from "./rotations";
import { ownedBy } from "./state";
import { addDays, DUE_SOON_DAYS, isDay, periodDays } from "./rotation";
import type { Generation } from "./secret";

export type ProblemKind =
  | "no-map"
  | "bad-map"
  | "rotation-unreadable"
  | "no-rotation-date"
  | "bad-rotation-period"
  | "overdue"
  | "due-soon"
  | "authority-unknown"
  | "missing-receipt"
  | "stale-receipt"
  | "rotation-unfinished";

export interface Problem {
  kind: ProblemKind;
  severity: "problem" | "notice";
  project: string;
  keyId?: KeyId;
  environment?: Environment;
  destinationId?: string;
  message: string;
}

export interface DestinationRow {
  destinationId: string;
  account: string;
  receipt: { generation: Generation; at: string; publisher: string } | null;
  stale: boolean | null;
}

export interface StatusRow {
  project: string;
  keyId: KeyId;
  environment: Environment;
  ref: KeyRef;
  rotated: string | null;
  rotateEvery: string | null;
  due: string | null;
  authority: "unknown";
  destinations: DestinationRow[];
}

export interface StatusInput {
  registry: Registry;
  maps: ReadonlyMap<string, MapResult>;
  receipts: readonly Receipt[];
  metadata(ref: KeyRef): VaultMetadata | null;
  generation?(keyId: KeyId, environment: Environment): Generation | undefined;
  rotations?: readonly Rotation[];
  today: string;
}

export interface Status {
  rows: StatusRow[];
  problems: Problem[];
}

const NOTICES: readonly ProblemKind[] = ["due-soon", "authority-unknown", "rotation-unfinished"];

export function buildStatus(input: StatusInput): Status {
  if (!isDay(input.today)) throw new Error(`today must be YYYY-MM-DD, got "${input.today}"`);
  const rows: StatusRow[] = [];
  const problems: Problem[] = [];

  for (const project of input.registry.projects) {
    const result = input.maps.get(project);
    if (!result) {
      problems.push({
        kind: "no-map",
        severity: "problem",
        project,
        message: `${project} has no readable keypin.toml`,
      });
      continue;
    }
    if (!result.ok) {
      problems.push({
        kind: "bad-map",
        severity: "problem",
        project,
        message: result.errors.join("\n"),
      });
      continue;
    }
    const latest = new Map(latestPerSecret(input.receipts).map((r) => [receiptSecretKey(r), r]));
    for (const key of result.map.keys) {
      for (const environment of result.map.environments) {
        const entry = key.environments[environment];
        if (!entry) continue;
        const where = { project, keyId: key.name, environment };
        const owner = { keyId: key.name, environment, mapFile: result.map.file };
        const label = `${key.name} (${environment})`;
        const add = (kind: ProblemKind, message: string, extra: Partial<Problem> = {}) =>
          problems.push({
            kind,
            severity: NOTICES.includes(kind) ? "notice" : "problem",
            ...where,
            ...extra,
            message,
          });

        const metadata = input.metadata(entry.ref);
        const rotateEvery = key.rotateEvery;
        const rotated = metadata?.rotated ?? null;
        const due = rotationDue({ label, metadata, rotated, rotateEvery, today: input.today, add });

        add(
          "authority-unknown",
          `${label}: what this key grants is unknown, because keypin didn't create it`,
        );

        const current = input.generation?.(key.name, environment);
        const destinations = entry.publish.map((target): DestinationRow => {
          const id = destinationId(target, key.name);
          const last = latest.get(secretKey(target, key.name));
          const ours =
            last &&
            (ownedBy(last, owner) || (last.source !== null && sameRef(last.source, entry.ref)));
          const receipt = ours ? last : undefined;
          if (!receipt) {
            add("missing-receipt", `${label}: no receipt for ${id}, so what it holds is unknown`, {
              destinationId: id,
            });
            return { destinationId: id, account: target.account, receipt: null, stale: null };
          }
          const stale = current === undefined ? null : receipt.generation !== current;
          if (stale) {
            add(
              "stale-receipt",
              `${label}: ${id} last got generation ${receipt.generation}, and the value is now ${current}`,
              {
                destinationId: id,
              },
            );
          }
          const { generation, at } = receipt;
          return {
            destinationId: id,
            account: target.account,
            receipt: { generation, at, publisher: receipt.account.publisher },
            stale,
          };
        });

        const rotation = unfinishedRotation(
          { version: ROTATIONS_VERSION, rotations: [...(input.rotations ?? [])] },
          owner,
          entry.ref,
        );
        if (rotation) {
          add(
            "rotation-unfinished",
            `${label}: a rotation started ${rotation.startedAt} is at stage "${rotation.stage}"; run ${rotateCommand(key.name, environment, publishEnvironment(result.map))} to continue`,
          );
        }

        rows.push({
          ...where,
          ref: entry.ref,
          rotated,
          rotateEvery,
          due,
          authority: "unknown",
          destinations,
        });
      }
    }
  }
  return { rows, problems };
}

function rotationDue(input: {
  label: string;
  metadata: VaultMetadata | null;
  rotated: string | null;
  rotateEvery: string | null;
  today: string;
  add: (kind: ProblemKind, message: string) => void;
}): string | null {
  const { label, metadata, rotated, rotateEvery, today, add } = input;
  if (!metadata) {
    add(
      "rotation-unreadable",
      `${label}: the vault item's rotated date couldn't be read, so whether it's due is unknown`,
    );
    return null;
  }
  if (!rotated || !isDay(rotated)) {
    add(
      "no-rotation-date",
      `${label}: ${rotated ? `rotated "${rotated}" isn't YYYY-MM-DD` : "no rotated date"}`,
    );
    return null;
  }
  const days = periodDays(rotateEvery);
  if (days === undefined) {
    add(
      "bad-rotation-period",
      rotateEvery
        ? `${label}: rotate_every is "${rotateEvery}"; use <n>d, <n>w, <n>m or never`
        : `${label}: keypin.toml has no rotate_every for this key; add one, such as "90d", or "never"`,
    );
    return null;
  }
  if (days === null) return null;
  const due = addDays(rotated, days);
  if (due < today)
    add("overdue", `${label}: was due ${due} (rotated ${rotated}, every ${rotateEvery})`);
  else if (due <= addDays(today, DUE_SOON_DAYS))
    add("due-soon", `${label}: is due ${due} (rotated ${rotated}, every ${rotateEvery})`);
  return due;
}
