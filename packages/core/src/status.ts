import type { Environment, KeyId, KeyRef, Receipt, VaultMetadata } from "./contracts";
import { destinationId, type DestinationKinds, receiptSecretKey, secretKey } from "./destination";
import { envFlag, type KeyEntry, type MapResult, pairedWith, publishEnvironment } from "./map";
import { latestPerSecret } from "./plan";
import type { VaultKinds } from "./login";
import type { PullReader } from "./pull";
import { sameRef, vaultKindOf } from "./reference";
import type { Registry } from "./registry";
import { ownedBy } from "./state";
import { addDays, type Day } from "./days";
import type { Generation } from "./secret";

const DUE_SOON_DAYS = 14;

export type ProblemKind =
  | "no-map"
  | "bad-map"
  | "no-keys"
  | "rotation-unreadable"
  | "no-rotation-date"
  | "bad-rotation-period"
  | "overdue"
  | "due-soon"
  | "never-published"
  | "missing-receipt"
  | "stale-receipt";

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
  rotated: Day | null;
  rotateEvery: string | null;
  due: Day | null;
  issuer: string | null;
  rotatesWith?: KeyId;
  destinations: DestinationRow[];
  pull: PullReader[];
}

export interface StatusInput {
  kinds: DestinationKinds;
  vaults: VaultKinds;
  registry: Registry;
  maps: ReadonlyMap<string, MapResult>;
  receipts: readonly Receipt[];
  metadata(ref: KeyRef): VaultMetadata | null;
  generation?(keyId: KeyId, environment: Environment): Generation | undefined;
  today: Day;
}

export interface Status {
  rows: StatusRow[];
  problems: Problem[];
}

const NOTICES: readonly ProblemKind[] = ["due-soon", "never-published"];

export function buildStatus(input: StatusInput): Status {
  const rows: StatusRow[] = [];
  const problems: Problem[] = [];

  for (const project of input.registry.projects) {
    const result = input.maps.get(project);
    if (!result) {
      problems.push({
        kind: "no-map",
        severity: "problem",
        project,
        message: `${project} has no readable secretspec.toml`,
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
    if (!result.map.keys.length) {
      problems.push({
        kind: "no-keys",
        severity: "problem",
        project,
        message: `${result.map.file} maps no keys yet (it's empty, or still the keypin init template); run keypin check in ${project} for what to add`,
      });
      continue;
    }
    const { kinds } = input;
    const latest = new Map(
      latestPerSecret(input.receipts, kinds).map((r) => [receiptSecretKey(r, kinds), r]),
    );
    for (const key of result.map.keys) {
      for (const environment of result.map.environments) {
        const entry = key.environments[environment];
        if (!entry) continue;
        const where = { project, keyId: key.name, environment };
        const owner = { keyId: key.name, environment, mapFile: result.map.file };
        const label = `${key.name} (${environment})`;
        const undated = vaultKindOf(input.vaults, entry.ref.kind).keepsRotated === false;
        const add = (kind: ProblemKind, message: string, extra: Partial<Problem> = {}) =>
          problems.push({
            kind,
            severity:
              NOTICES.includes(kind) || (undated && kind === "no-rotation-date")
                ? "notice"
                : "problem",
            ...where,
            ...extra,
            message,
          });

        const metadata = input.metadata(entry.ref);
        const rotated = metadata?.rotated ?? null;
        const holder = pairedWith(result.map, key.name, environment);
        const holderRef = holder?.environments[environment]?.ref;
        const rotateEvery = holder ? holder.rotateEvery : key.rotateEvery;
        const due = holderRef
          ? rotationDue({
              label,
              metadata: input.metadata(holderRef),
              rotated: input.metadata(holderRef)?.rotated ?? null,
              rotateEvery,
              today: input.today,
              add: () => {},
            })
          : rotationDue({ label, metadata, rotated, rotateEvery, today: input.today, add });

        const current = input.generation?.(key.name, environment);
        const published = input.receipts.some((r) => ownedBy(r, owner));
        const unpublished: string[] = [];
        const publish = `keypin publish ${key.name}${envFlag(environment, publishEnvironment(result.map))}`;
        const destinations = entry.publish.map((target): DestinationRow => {
          const id = destinationId(target, key.name, kinds);
          const last = latest.get(secretKey(target, key.name, kinds));
          const ours =
            last &&
            (ownedBy(last, owner) ||
              (last.source !== null && sameRef(last.source, entry.ref, input.vaults)));
          const receipt = ours ? last : undefined;
          if (!receipt) {
            if (last) {
              add(
                "missing-receipt",
                `${label}: ${id}'s last receipt isn't from this project or this key's item, so what it holds is unknown`,
                { destinationId: id },
              );
            } else if (published) {
              add(
                "missing-receipt",
                `${label}: no receipt for ${id}, though this project published this key before, so what it holds is unknown; ${publish} writes it again`,
                { destinationId: id },
              );
            } else {
              unpublished.push(id);
            }
            return { destinationId: id, account: target.account, receipt: null, stale: null };
          }
          const stale = current === undefined ? null : receipt.generation !== current;
          if (stale) {
            add(
              "stale-receipt",
              `${label}: ${id} last got generation ${receipt.generation}, and the value is now ${current}`,
              { destinationId: id },
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

        if (unpublished.length) {
          add(
            "never-published",
            `${label}: not published yet to ${unpublished.join(", ")}; run ${publish}`,
          );
        }

        rows.push({
          ...where,
          ref: entry.ref,
          rotated,
          rotateEvery: rotateEvery?.text ?? null,
          due,
          issuer: entry.issuer?.kind ?? null,
          ...(holder ? { rotatesWith: holder.name } : {}),
          destinations,
          pull: entry.pull,
        });
      }
    }
  }
  return { rows, problems };
}

function rotationDue(input: {
  label: string;
  metadata: VaultMetadata | null;
  rotated: Day | null;
  rotateEvery: KeyEntry["rotateEvery"];
  today: Day;
  add: (kind: ProblemKind, message: string) => void;
}): Day | null {
  const { label, metadata, rotated, rotateEvery, today, add } = input;
  if (!metadata) {
    add(
      "rotation-unreadable",
      `${label}: the vault item's rotated date couldn't be read, so whether it's due is unknown`,
    );
    return null;
  }
  if (!rotated) {
    add("no-rotation-date", `${label}: no rotated date`);
    return null;
  }
  if (!rotateEvery) {
    add(
      "bad-rotation-period",
      `${label}: secretspec.toml has no rotate_every for this key; add one, such as "90d", or "never"`,
    );
    return null;
  }
  if (rotateEvery.days === null) return null;
  const due = addDays(rotated, rotateEvery.days);
  const every = rotateEvery.text;
  if (due < today) add("overdue", `${label}: was due ${due} (rotated ${rotated}, every ${every})`);
  else if (due <= addDays(today, DUE_SOON_DAYS))
    add("due-soon", `${label}: is due ${due} (rotated ${rotated}, every ${every})`);
  return due;
}
