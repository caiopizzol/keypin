import { type SignInReason, sentence, type VaultKind } from "@keypin/core";
import { ACCESS_TOKEN, NO_CREDENTIALS } from "./access-token";
import type { BitwardenRef, BitwardenReference } from "./reference";
import { bitwardenVaultRules } from "./rules";

function fixFor(failures: readonly SignInReason[]): string {
  if (failures.some((reason) => reason.kind === "no-credentials"))
    return `${NO_CREDENTIALS} (docs/integrations/vaults/bitwarden.md)`;
  return `check ${ACCESS_TOKEN} and the server in your bws:// provider in secretspec.toml`;
}

export const bitwardenVault: VaultKind<unknown, BitwardenRef, BitwardenReference> = {
  ...bitwardenVaultRules,
  newValueByHand: "Put a new value in the Bitwarden secret and set rotated in its note to today",
  addRotatedDate:
    "Add a line rotated: YYYY-MM-DD to the Bitwarden secret's note, with the day the value last changed.",
  signInVariables: [ACCESS_TOKEN],
  addByHand: (map) => {
    const refs = map.keys.flatMap((key) =>
      Object.values(key.environments).flatMap((entry) => (entry ? [entry.ref] : [])),
    );
    return refs.length > 0 && refs.every((ref) => ref.kind === "bitwarden")
      ? "declare the secrets in secretspec.toml, then save each value in Bitwarden Secrets Manager with secretspec set (docs/integrations/vaults/bitwarden.md)"
      : undefined;
  },
  prerequisites({ failures }) {
    if (!failures.length) return [];
    const fix = fixFor(failures);
    return [
      {
        name: "Bitwarden",
        status: "sign-in failed",
        fix,
        title: "Sign in to Bitwarden",
        body: [sentence(fix)],
        coversFailures: true,
      },
    ];
  },
};
