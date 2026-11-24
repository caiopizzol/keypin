import type { Environment, ItemIds, KeyId, KeyRef, Receipt } from "./contracts";
import {
  destinationId,
  type DestinationKinds,
  type PublishTarget,
  receiptSecretKey,
  secretKey,
} from "./destination";
import type { VaultKinds } from "./login";
import type { KeyEntry } from "./map";
import { describeRef, sameAccount, sameField, sameRef } from "./reference";
import type { Generation } from "./secret";
import { type KeyOwner, ownedBy } from "./state";

type ApprovalReason = "no receipt" | "new destination" | "account changed" | "item changed";
type WriteReason = ApprovalReason | "different generation";
type SkipReason = "receipt already has this generation";

interface Approval {
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
      sameValue?: true;
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

interface PublishPlan {
  keyId: KeyId;
  environment: Environment;
  generation: Generation;
  steps: PlanStep[];
  removed: RemovedDestination[];
  needsApproval: boolean;
}

export interface PlanInput {
  kinds: DestinationKinds;
  vaults: VaultKinds;
  key: KeyEntry;
  environment: Environment;
  mapFile: string;
  receipts: readonly Receipt[];
}

interface ReadPlanInput extends PlanInput {
  generation: Generation;
  ids: ItemIds | null;
}

const ownerOf = ({ key, environment, mapFile }: PlanInput): KeyOwner => ({
  keyId: key.name,
  environment,
  mapFile,
});

export function approvalsFor(
  input: PlanInput,
  ids: ItemIds | null = null,
): (Approval & { destinationId: string })[] {
  return judge(input, ids).flatMap(({ id, approval }) =>
    approval ? [{ destinationId: id, ...approval }] : [],
  );
}

export function planPublish(input: ReadPlanInput): PublishPlan {
  const { key, environment, generation, kinds } = input;
  const steps = judge(input, input.ids).map(({ id, target, receipt, approval }): PlanStep => {
    if (approval) {
      const sameValue = approval.reason === "item changed" && receipt?.generation === generation;
      return {
        action: "write",
        destinationId: id,
        target,
        ...approval,
        ...(sameValue && { sameValue }),
      };
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

  const listed = new Set(
    steps.flatMap((s) => [secretKey(s.target, key.name, kinds), s.destinationId]),
  );
  const removed = latestPerSecret(input.receipts, kinds)
    .filter((r) => ownedBy(r, ownerOf(input)))
    .filter((r) => !listed.has(receiptSecretKey(r, kinds)) && !listed.has(r.destinationId))
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

export function planNewValue(input: PlanInput, ids: ItemIds | null): PlanStep[] {
  return judge(input, ids).map(({ id, target, approval }) => ({
    action: "write",
    destinationId: id,
    target,
    ...(approval ?? { reason: "different generation", approval: null }),
  }));
}

function judge(input: PlanInput, ids: ItemIds | null) {
  const { key, environment, kinds } = input;
  const entry = key.environments[environment];
  if (!entry) throw new Error(`key "${key.name}" has no ${environment} entry in secretspec.toml`);
  const newest = latestPerSecret(input.receipts, kinds);
  const latest = new Map(newest.map((r) => [receiptSecretKey(r, kinds), r]));
  const owner = ownerOf(input);
  const ours = newest.filter((r) => ownedBy(r, owner));
  const published = input.receipts.some((r) => ownedBy(r, owner));

  return entry.publish.map((target) => {
    const id = destinationId(target, key.name, kinds);
    const receipt =
      latest.get(secretKey(target, key.name, kinds)) ?? ours.find((r) => r.destinationId === id);
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
    const changed = itemChange(receipt, entry.ref, ids, input.vaults);
    if (changed) return needs("item changed", `${id} was last published from ${changed}`);
    return { id, target, receipt, approval: null };
  });
}

function itemChange(
  receipt: Receipt,
  ref: KeyRef,
  ids: ItemIds | null,
  vaults: VaultKinds,
): string | null {
  const { source, sourceIds } = receipt;
  const describe = (r: KeyRef) => describeRef(r, vaults);
  const now = `and now from ${describe(ref)}`;
  if (!source) return `an item its receipt doesn't record, ${now}`;
  const before = `${describe(source)}, ${now}`;
  if (!sourceIds) return sameRef(source, ref, vaults) ? null : before;
  if (!sameAccount(source, ref, vaults) || !sameField(source, ref, vaults)) return before;
  if (ids === null || (ids.vault === sourceIds.vault && ids.item === sourceIds.item)) return null;
  return `${describe(source)} (item ${sourceIds.item} in vault ${sourceIds.vault}), and now from ${describe(ref)} (item ${ids.item} in vault ${ids.vault})`;
}

export function latestPerSecret(receipts: readonly Receipt[], kinds: DestinationKinds): Receipt[] {
  const latest = new Map<string, Receipt>();
  for (const receipt of receipts) {
    const key = receiptSecretKey(receipt, kinds);
    const seen = latest.get(key);
    if (!seen || seen.at < receipt.at) latest.set(key, receipt);
  }
  return [...latest.values()];
}
