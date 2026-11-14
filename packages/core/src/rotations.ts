import type { Generation } from "./secret";
import type { Issued } from "./state";

export type NextRotation =
  | { action: "resume"; issued: Issued }
  | { action: "create"; current: string | null; abandoned: Issued | null };

export function nextRotation(input: {
  issued: Issued | undefined;
  issuer: string;
  generation: Generation;
  published: boolean;
}): NextRotation {
  const { issued, issuer, generation, published } = input;
  if (!issued) return { action: "create", current: null, abandoned: null };
  if (issued.issuer !== issuer) return { action: "create", current: null, abandoned: issued };
  if (issued.generation === generation) {
    const revokeLeft = issued.old.id !== null && !issued.old.revoked;
    return !published || revokeLeft
      ? { action: "resume", issued }
      : { action: "create", current: issued.id, abandoned: null };
  }
  if (issued.old.generation === generation)
    return { action: "create", current: issued.old.id, abandoned: issued };
  return { action: "create", current: null, abandoned: issued };
}
