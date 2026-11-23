import type { VaultRules } from "@keypin/core";
import {
  account,
  type BitwardenRef,
  type BitwardenReference,
  decode,
  format,
  parse,
  SCHEME,
} from "./reference";

export const bitwardenVaultRules: VaultRules<BitwardenRef, BitwardenReference> = {
  kind: "bitwarden",
  name: "Bitwarden",
  scheme: SCHEME,
  placeholder: "the project's name or ID, and the secret's name",
  parse,
  pinned: (reference, like) => ({ ...like, ...reference }),
  format,
  account,
  sameItem: (a, b) => a.project === b.project && a.name === b.name,
  stored: decode,
  secretspec: { provider: "bws" },
};
