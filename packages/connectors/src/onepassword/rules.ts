import type { VaultRules } from "@keypin/core";
import { locate } from "./secretspec";
import {
  account,
  decode,
  format,
  type OnePasswordRef,
  type OnePasswordReference,
  parse,
  SCHEME,
  sameName,
} from "./reference";

const readable = (ref: OnePasswordRef) =>
  ref.fallback === undefined ? [ref.field] : [ref.field, ref.fallback];

export const onePasswordVaultRules: VaultRules<OnePasswordRef, OnePasswordReference> = {
  kind: "1password",
  name: "1Password",
  scheme: SCHEME,
  placeholder:
    "the field's secret reference (in 1Password, open the field's menu and select Copy Secret Reference)",
  parse,
  pinned: (reference, like) => ({ ...reference, account: like.account }),
  format,
  account,
  accounts: (refs) => [
    `1Password account ${[...new Set(refs.map((ref) => ref.account))].join(", ")}`,
  ],
  sameItem: (a, b) => sameName(a.vault, b.vault) && sameName(a.item, b.item),
  sameField: (a, b) =>
    sameName(a.section, b.section) &&
    sameName(a.field, b.field) &&
    sameName(a.fallback ?? null, b.fallback ?? null),
  mayShareField: (a, b) =>
    (a.section === null || b.section === null || sameName(a.section, b.section)) &&
    readable(a).some((field) => readable(b).some((other) => sameName(field, other))),
  describe: (ref) =>
    ref.fallback === undefined
      ? format(ref)
      : `${format(ref)} (${ref.field}, then ${ref.fallback})`,
  stored: decode,
  newKeys: {
    provider: "onepassword://<1Password sign-in address>@<vault>",
    options: "--vault <vault>",
    account: "--account <1Password sign-in address>",
  },
  secretspec: { provider: "onepassword", locate },
};
