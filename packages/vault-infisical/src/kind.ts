import { type SignInReason, sentence, type VaultKind } from "@keypin/core";
import { CLIENT_ID, CLIENT_SECRET } from "./backend";
import {
  account,
  decode,
  format,
  type InfisicalPin,
  type InfisicalRef,
  type InfisicalReference,
  parse,
  readPin,
  SCHEME,
} from "./reference";

function fixFor(failures: readonly SignInReason[]): string {
  if (failures.some((reason) => reason.kind === "no-credentials"))
    return `set ${CLIENT_ID} and ${CLIENT_SECRET} to a machine identity's Universal Auth client ID and secret (docs/infisical.md)`;
  if (failures.some((reason) => reason.kind === "wrong-account"))
    return "use a machine identity from the organization keypin.toml pins under [infisical]";
  return `check ${CLIENT_ID}, ${CLIENT_SECRET} and the url under [infisical] in keypin.toml`;
}

export const infisicalVault: VaultKind<unknown, InfisicalRef, InfisicalReference, InfisicalPin> = {
  kind: "infisical",
  scheme: SCHEME,
  placeholder: "the project's slug, the environment's slug, and the secret's name",
  needsPin: `needs your Infisical organization: add [infisical] with organization = "..."`,
  readPin,
  parse,
  pinned: (reference, pin) => ({ ...reference, ...pin }),
  format,
  account,
  sameItem: (a, b) =>
    a.project === b.project &&
    a.environment === b.environment &&
    a.path === b.path &&
    a.name === b.name,
  stored: decode,
  prerequisites({ failures }) {
    if (!failures.length) return [];
    const fix = fixFor(failures);
    return [
      {
        name: "Infisical",
        status: "sign-in failed",
        fix,
        title: "Sign in to Infisical",
        body: [sentence(fix)],
        coversFailures: true,
      },
    ];
  },
};
