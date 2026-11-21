import type { VaultRules } from "@keypin/core";
import {
  account,
  decode,
  type DopplerPin,
  type DopplerRef,
  type DopplerReference,
  format,
  parse,
  readPin,
  SCHEME,
} from "./reference";

export const dopplerVaultRules: VaultRules<DopplerRef, DopplerReference, DopplerPin> = {
  kind: "doppler",
  name: "Doppler",
  scheme: SCHEME,
  placeholder: "the project's name, the config's name, and the secret's name",
  needsPin: `needs your Doppler workplace: add [doppler] with workplace = "..."`,
  readPin,
  parse,
  pinned: (reference, pin) => ({ ...reference, ...pin }),
  format,
  account,
  sameItem: (a, b) => a.project === b.project && a.config === b.config && a.name === b.name,
  stored: decode,
};
