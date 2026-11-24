import {
  type Issued,
  type Issuer,
  type IssuerSpec,
  type NextRotation,
  ownedBy,
  type PlanStep,
  proves,
  recordIssued,
  saveState,
  type Secret,
  type State,
  waitsForRevoke,
} from "@keypin/core";
import { commandLine } from "../../approval";
import { confirm } from "../../output";
import { ROTATION_FILE } from "../../project";
import { type Job, terminalArgs } from "./job";
import { shown } from "./messages";

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

export function unsignedStop(
  job: Job,
  issuer: Issuer,
  next: NextRotation,
  inVault: string | null,
  named: string | undefined,
): boolean {
  const recorded = next.action === "create" ? next.current : null;
  if (job.pair || recorded === null || inVault !== null || named !== undefined) return false;
  if (job.deps.isTerminal) return false;
  job.out.line(
    `\nStopped: ${ROTATION_FILE} records key ${shown(issuer, recorded)} for the vault's value without a proof, and ${issuer.describe()} can't confirm which key the vault holds. Run this once in a terminal to check the plan before keypin creates a key:\n  ${commandLine(job.deps, "rotate", terminalArgs(job.args))}\nNothing was created.`,
  );
  return true;
}

export async function unprovenRevoke(
  job: Job,
  issuer: Issuer,
  issued: Issued,
  state: State,
): Promise<number> {
  const { deps, out } = job;
  const old = shown(issuer, issued.old.id ?? "");
  out.line(
    `${ROTATION_FILE} names key ${old} as the old key without a proof, so keypin can't confirm it and won't revoke it: an older keypin recorded it, or someone removed the proof. Check which key this rotation replaced at ${issuer.dashboard()}, and delete it yourself once nothing uses it.`,
  );
  if (!deps.isTerminal) {
    out.line(
      `Stopped. Nothing was revoked. Once you've deleted it, run this in a terminal to record it:\n  ${commandLine(deps, "rotate", terminalArgs(job.args))}`,
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
): Promise<number | null> {
  if (job.due || job.plan || next.action !== "resume") return null;
  if ((await proves(next.issued, vault, "new")) !== undefined) return null;
  return unprovenRevoke(job, issuer, next.issued, state);
}
