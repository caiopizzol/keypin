import {
  type Issued,
  type Issuer,
  type IssuerSpec,
  type NextRotation,
  ownedBy,
  type PlanStep,
  proves,
  type Secret,
  type State,
  waitsForRevoke,
} from "@keypin/core";
import { commandLine } from "../../approval";
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
