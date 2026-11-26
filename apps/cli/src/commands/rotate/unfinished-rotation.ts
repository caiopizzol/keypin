import {
  type Issued,
  type Issuer,
  type IssuerSpec,
  keyIdText,
  type NextRotation,
  ownedBy,
  type PlanStep,
  proves,
  recordIssued,
  type RemovedDestination,
  removedBehind,
  saveState,
  type Secret,
  type State,
  waitsForRevoke,
} from "@keypin/core";
import { terminalCommand } from "../../approval";
import { confirm } from "../../output";
import { ROTATION_FILE } from "../../project";
import { type Job, terminalArgs } from "./job";
import { revokeRefused, shown } from "./messages";
import { showRemoved } from "../../publishing";

export function revokeOnly(
  next: NextRotation,
  steps: readonly PlanStep[],
  idSaved: boolean,
): boolean {
  return (
    next.action === "resume" &&
    waitsForRevoke(next.issued) &&
    !next.issued.held &&
    idSaved &&
    steps.every((step) => step.action === "skip")
  );
}

export function resetHeld(
  issuer: { createResetsOld?: boolean },
  spec: IssuerSpec,
  abandoned: Issued | null,
  generation: string,
): Issued | null {
  return issuer.createResetsOld &&
    abandoned?.issuer === spec.kind &&
    abandoned.old.generation === generation
    ? abandoned
    : null;
}

export function neverSaved(abandoned: Issued, spec: IssuerSpec, generation: string, state: State) {
  return (
    abandoned.issuer === spec.kind &&
    abandoned.old.generation === generation &&
    !state.receipts.some((r) => ownedBy(r, abandoned) && r.generation === abandoned.generation)
  );
}

export async function provenId(
  recorded: Issued | undefined,
  id: string | null,
  vault: Secret,
): Promise<string | null> {
  if (!recorded || id === null) return null;
  if (id === recorded.id && (await proves(recorded, vault, "new"))) return id;
  if (id === recorded.old.id && (await proves(recorded, vault, "old"))) return id;
  return null;
}

export function migrationNote(
  job: Job,
  issuer: Issuer,
  next: NextRotation,
  inVault: string | null,
  named: string | undefined,
): string | null {
  const recorded = next.action === "create" ? next.current : null;
  if (job.pair || !issuer.revoke || recorded === null || inVault !== null) return null;
  if (named !== undefined) return null;
  const record = job.committed === null ? "keypin's record on this machine" : ROTATION_FILE;
  const note = `${record} names key ${shown(issuer, recorded)} for the vault's value without a proof: an older keypin recorded it, or someone removed the proof. ${issuer.describe()} can't confirm which key the vault holds, so a person approves this rotation in a terminal before keypin creates a key.`;
  if (!job.check) return note;
  const then = job.committed === null ? "" : ", then commit .keypin/";
  return `${note} Run this in a terminal${then}. keypin records the new key with a proof, so this check passes:\n  ${terminalCommand(job.deps, "rotate", terminalArgs(job.args))}`;
}

export async function unprovenRevoke(
  job: Job,
  issuer: Issuer,
  issued: Issued,
  state: State,
): Promise<number> {
  const { deps, out } = job;
  const old = shown(issuer, issued.old.id ?? "");
  if (issued.old.id === issued.id) {
    out.line(revokeRefused(issuer, issued.old.id, "it's the key the vault holds"));
    return 1;
  }
  out.line(
    `${ROTATION_FILE} names key ${old} as the old key without a proof, so keypin can't confirm it and won't revoke it: an older keypin recorded it, or someone removed the proof. Check which key this rotation replaced at ${issuer.dashboard()}, and delete it yourself once nothing uses it.`,
  );
  if (!deps.isTerminal) {
    out.line(
      `Stopped. Nothing was revoked. Once you've deleted it, run this in a terminal to record it:\n  ${terminalCommand(deps, "rotate", terminalArgs(job.args))}`,
    );
    return 1;
  }
  if (!(await confirm(deps, "Did you delete the old key yourself? Record it as revoked?"))) {
    out.line("Nothing was recorded.");
    return 1;
  }
  const revoked = { ...issued, old: { ...issued.old, revoked: true } };
  await saveState(deps.files, job.path, recordIssued(state, revoked));
  out.line("Recorded the old key as revoked. keypin deleted nothing.");
  return 0;
}

export async function settlesUnproven(
  job: Job,
  issuer: Issuer,
  next: NextRotation,
  vault: Secret,
  state: State,
  removed: readonly RemovedDestination[],
): Promise<number | null> {
  if (job.due || job.plan || job.discard || next.action !== "resume") return null;
  if ((await proves(next.issued, vault, "new")) !== undefined) return null;
  warnBehind(job, removed, next.issued.generation);
  return unprovenRevoke(job, issuer, next.issued, state);
}

export function warnBehind(
  { committed, map, deps, owner, out }: Job,
  removed: readonly RemovedDestination[],
  generation: string,
): RemovedDestination[] {
  const recorded = removedBehind(committed, map, deps.destinations, owner, generation)
    .filter((p) => !removed.some((r) => r.destinationId === p.destination))
    .map((p) => ({
      destinationId: p.destination,
      lastReceipt: { generation: p.generation, at: p.at, destinationAccount: "unknown" },
    }));
  const behind = [...removed.filter((r) => r.lastReceipt.generation !== generation), ...recorded];
  if (behind.length) {
    out.line(
      "Not in secretspec.toml any more, so keypin didn't write them; they may still use the old key:",
    );
    showRemoved(out, behind);
  }
  return behind;
}

export async function idInVault(
  next: NextRotation,
  recorded: Issued | undefined,
  vault: Secret,
  pair: Secret | null,
): Promise<string | null> {
  if (pair) return next.action === "resume" ? next.issued.id : keyIdText(pair);
  const id =
    next.action === "resume" ? next.issued.id : next.action === "create" ? next.current : null;
  return provenId(recorded, id, vault);
}
