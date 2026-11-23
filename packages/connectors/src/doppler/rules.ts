import type { VaultRules } from "@keypin/core";
import { account, decode, type DopplerRef, format, parse, SCHEME } from "./reference";
import { locate } from "./secretspec";

export const dopplerVaultRules: VaultRules<DopplerRef, DopplerRef> = {
  kind: "doppler",
  name: "Doppler",
  scheme: SCHEME,
  placeholder: "the project's name, the config's name, and the secret's name",
  parse,
  pinned: (reference) => reference,
  format,
  account,
  sameItem: (a, b) => a.project === b.project && a.config === b.config && a.name === b.name,
  stored: decode,
  secretspec: { provider: "doppler", locate },
};
