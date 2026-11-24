import {
  type Issued,
  type IssuerSpec,
  type NextRotation,
  ownedBy,
  type PlanStep,
  proves,
  type Secret,
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
