import type { Environment, KeyId, KeyRef, Receipt } from "./contracts";
import {
  destinationId,
  type KeyEntry,
  type PublishTarget,
  receiptSecretKey,
  secretKey,
} from "./map";
import { formatReference, sameRef } from "./reference";
import type { Generation } from "./secret";
import { type KeyOwner, ownedBy } from "./state";

export type ApprovalReason = "no receipt" | "new destination" | "account changed" | "item changed";
export type WriteReason = ApprovalReason | "different generation";
export type SkipReason = "receipt already has this generation";

export interface Approval {
  reason: ApprovalReason;
  approval: string;
}

export type PlanStep =
  | {
      action: "write";
      destinationId: string;
      target: PublishTarget;
      reason: WriteReason;
      approval: string | null;
    }
  | {
      action: "skip";
      destinationId: string;
      target: PublishTarget;
      reason: SkipReason;
      approval: null;
    };

export interface RemovedDestination {
  destinationId: string;
  lastReceipt: { generation: Generation; at: string; destinationAccount: string };
}

export interface PublishPlan {
  keyId: KeyId;
  environment: Environment;
  generation: Generation;
  steps: PlanStep[];
  removed: RemovedDestination[];
  needsApproval: boolean;
}

export interface PlanInput {
  key: KeyEntry;
  environment: Environment;
  mapFile: string;
  receipts: readonly Receipt[];
}

const ownerOf = ({ key, environment, mapFile }: PlanInput): KeyOwner => ({
  keyId: key.name,
  environment,
  mapFile,
});

export function approvalsFor(input: PlanInput): (Approval & { destinationId: string })[] {
  return judge(input).flatMap(({ id, approval }) =>
    approval ? [{ destinationId: id, ...approval }] : [],
  );
}

export function planPublish(input: PlanInput & { generation: Generation }): PublishPlan {
  const { key, environment, generation } = input;
  const steps = judge(input).map(({ id, target, receipt, approval }): PlanStep => {
    if (approval) {
      return { action: "write", destinationId: id, target, ...approval };
    }
    if (receipt?.generation === generation) {
      return {
        action: "skip",
        destinationId: id,
        target,
        reason: "receipt already has this generation",
        approval: null,
      };
    }
    return {
      action: "write",
      destinationId: id,
      target,
      reason: "different generation",
      approval: null,
    };
  });

  const listed = new Set(steps.flatMap((s) => [secretKey(s.target, key.name), s.destinationId]));
  const removed = latestPerSecret(input.receipts)
    .filter((r) => ownedBy(r, ownerOf(input)))
    .filter((r) => !listed.has(receiptSecretKey(r)) && !listed.has(r.destinationId))
    .map((r) => ({
      destinationId: r.destinationId,
      lastReceipt: {
        generation: r.generation,
        at: r.at,
        destinationAccount: r.account.destinationAccount,
      },
    }));

  return {
    keyId: key.name,
    environment,
    generation,
    steps,
    removed,
    needsApproval: steps.some((s) => s.approval !== null),
  };
}

function judge(input: PlanInput) {
  const { key, environment } = input;
  const entry = key.environments[environment];
  if (!entry) throw new Error(`key "${key.name}" has no ${environment} entry in the map`);
  const newest = latestPerSecret(input.receipts);
  const latest = new Map(newest.map((r) => [receiptSecretKey(r), r]));
  const owner = ownerOf(input);
  const ours = newest.filter((r) => ownedBy(r, owner));
  const published = input.receipts.some((r) => ownedBy(r, owner));

  return entry.publish.map((target) => {
    const id = destinationId(target, key.name);
    const receipt =
      latest.get(secretKey(target, key.name)) ?? ours.find((r) => r.destinationId === id);
    const needs = (reason: ApprovalReason, approval: string) => ({
      id,
      target,
      receipt,
      approval: { reason, approval },
    });
    if (!receipt) {
      return needs(
        published ? "new destination" : "no receipt",
        `first write to ${id} (account ${target.account})`,
      );
    }
    if (receipt.account.pinned !== target.account) {
      return needs(
        "account changed",
        `${id} account changed from ${receipt.account.pinned} to ${target.account}`,
      );
    }
    if (!receipt.source || !sameRef(receipt.source, entry.ref)) {
      const before = receipt.source
        ? describeRef(receipt.source)
        : "an item its receipt doesn't record";
      return needs(
        "item changed",
        `${id} was last published from ${before}, and now from ${describeRef(entry.ref)}`,
      );
    }
    return { id, target, receipt, approval: null };
  });
}

export function latestPerSecret(receipts: readonly Receipt[]): Receipt[] {
  const latest = new Map<string, Receipt>();
  for (const receipt of receipts) {
    const seen = latest.get(receiptSecretKey(receipt));
    if (!seen || seen.at < receipt.at) latest.set(receiptSecretKey(receipt), receipt);
  }
  return [...latest.values()];
}

function describeRef(ref: KeyRef): string {
  return `${formatReference(ref)} (1Password account ${ref.account})`;
}
