import type { VaultRules } from "@keypin/core";
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

export const bitwardenVaultRules: VaultRules<BitwardenRef, BitwardenReference, BitwardenPin> = {
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
};
