import { type SignInReason, sentence, type VaultKind } from "@keypin/core";
import { ACCESS_TOKEN, NO_CREDENTIALS } from "./backend";
import {
  account,
  type BitwardenPin,
  type BitwardenRef,
  type BitwardenReference,
  decode,
  format,
  parse,
  readPin,
  SCHEME,
} from "./reference";

function fixFor(failures: readonly SignInReason[]): string {
  if (failures.some((reason) => reason.kind === "no-credentials"))
    return `${NO_CREDENTIALS} (docs/bitwarden.md)`;
  if (failures.some((reason) => reason.kind === "wrong-account"))
    return "use an access token from a machine account in the organization keypin.toml pins under [bitwarden]";
  return `check ${ACCESS_TOKEN} and the url under [bitwarden] in keypin.toml`;
}

export const bitwardenVault: VaultKind<unknown, BitwardenRef, BitwardenReference, BitwardenPin> = {
  kind: "bitwarden",
  name: "Bitwarden",
  scheme: SCHEME,
  placeholder: "the project's name or ID, and the secret's name",
  needsPin: `needs your Bitwarden organization: add [bitwarden] with organization = "..."`,
  readPin,
  parse,
  pinned: (reference, pin) => ({ ...reference, ...pin }),
  format,
  account,
  sameItem: (a, b) => a.project === b.project && a.name === b.name,
  stored: decode,
  signInVariables: [ACCESS_TOKEN],
  newValueByHand: "Put a new value in the Bitwarden secret and set rotated in its note to today",
  addRotatedDate:
    "Add a line rotated: YYYY-MM-DD to the Bitwarden secret's note, with the day the value last changed.",
  addByHand: (map) => {
    const refs = map.keys.flatMap((key) =>
      Object.values(key.environments).flatMap((entry) => (entry ? [entry.ref] : [])),
    );
    return map.pins.bitwarden !== undefined && refs.every((ref) => ref.kind === "bitwarden")
      ? `add the secrets in Bitwarden Secrets Manager and map them with ${SCHEME} references (docs/bitwarden.md)`
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
