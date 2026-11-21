import type { VaultRules } from "@keypin/core";
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

export const infisicalVaultRules: VaultRules<InfisicalRef, InfisicalReference, InfisicalPin> = {
  kind: "infisical",
  name: "Infisical",
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
};
