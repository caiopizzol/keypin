import {
  type Issued,
  type IssuerSpec,
  type NextRotation,
  ownedBy,
  type PlanStep,
  type State,
  waitsForRevoke,
} from "@keypin/core";

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
