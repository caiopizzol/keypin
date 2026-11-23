import type { VaultRules } from "@keypin/core";
import {
  account,
  decode,
  format,
  type InfisicalRef,
  type InfisicalReference,
  parse,
  SCHEME,
} from "./reference";

export const infisicalVaultRules: VaultRules<InfisicalRef, InfisicalReference> = {
  kind: "infisical",
  name: "Infisical",
  scheme: SCHEME,
  placeholder: "the project's slug, the environment's slug, and the secret's name",
  parse,
  pinned: (reference, like) => ({ ...like, ...reference }),
  format,
  account,
  sameItem: (a, b) =>
    a.project === b.project &&
    a.environment === b.environment &&
    a.path === b.path &&
    a.name === b.name,
  stored: decode,
  secretspec: { provider: "infisical" },
};
