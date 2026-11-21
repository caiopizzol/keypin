import type { VaultRules } from "@keypin/core";
import {
  account,
  decode,
  format,
  type OnePasswordRef,
  type OnePasswordReference,
  parse,
  readPin,
  SCHEME,
  sameName,
} from "./reference";

export const onePasswordVaultRules: VaultRules<OnePasswordRef, OnePasswordReference, string> = {
  kind: "1password",
  name: "1Password",
  scheme: SCHEME,
  placeholder:
    "the field's secret reference (in 1Password, open the field's menu and select Copy Secret Reference)",
  needsPin: `needs your 1Password account: add [1password] with account = "..."`,
  readPin,
  parse,
  pinned: (reference, pinned) => ({ ...reference, account: pinned }),
  format,
  account,
  accounts: (refs) => [
    `1Password account ${[...new Set(refs.map((ref) => ref.account))].join(", ")}`,
  ],
  sameItem: (a, b) => sameName(a.vault, b.vault) && sameName(a.item, b.item),
  sameField: (a, b) => sameName(a.section, b.section) && sameName(a.field, b.field),
  stored: decode,
  newKeys: {
    reference: "<vault>/<item>/<field>",
    pin: { account: "<1Password sign-in address>" },
    options: "--vault <vault>",
  },
};
