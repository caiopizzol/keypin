import { type SignInReason, sentence, type VaultKind } from "@keypin/core";
import {
  AUDIENCE,
  credentialsFrom,
  IDENTITY_ID,
  NO_CREDENTIALS,
  NO_JOB_TOKEN,
  TOKEN_VARIABLE,
  tokenKind,
} from "./credentials";
import type { DopplerRef } from "./reference";
import { dopplerVaultRules } from "./rules";

interface DopplerHost {
  readonly env: Readonly<Record<string, string | undefined>>;
}

function fixFor(failures: readonly SignInReason[], { env }: DopplerHost): string {
  const credentials = credentialsFrom(env);
  if (credentials && "problem" in credentials) return credentials.problem;
  const oidc = credentials !== null && "identityId" in credentials;
  if (failures.some((reason) => reason.kind === "no-credentials"))
    return oidc ? NO_JOB_TOKEN : `${NO_CREDENTIALS} (docs/integrations/vaults/doppler.md)`;
  if (oidc)
    return `check ${IDENTITY_ID} and the identity's claims (docs/integrations/vaults/doppler.md)`;
  return `check ${TOKEN_VARIABLE}`;
}

function signedInWith({ env }: DopplerHost): string | null {
  const credentials = credentialsFrom(env);
  if (!credentials || "problem" in credentials) return null;
  if ("identityId" in credentials)
    return `GitHub Actions OIDC, as the service account identity in ${IDENTITY_ID}`;
  return `the ${tokenKind(credentials.token)} in ${TOKEN_VARIABLE}`;
}

export const dopplerVault: VaultKind<DopplerHost, DopplerRef> = {
  ...dopplerVaultRules,
  newValueByHand: "Put a new value in the Doppler secret",
  addRotatedDate:
    "Doppler keeps no rotated date on a secret, so keypin can't tell when this key is due (docs/integrations/vaults/doppler.md).",
  signInVariables: [TOKEN_VARIABLE, IDENTITY_ID, AUDIENCE],
  keepsRotated: false,
  addByHand: (map) => {
    const refs = map.keys.flatMap((key) =>
      Object.values(key.environments).flatMap((entry) => (entry ? [entry.ref] : [])),
    );
    return refs.length > 0 && refs.every((ref) => ref.kind === "doppler")
      ? "declare the secrets in secretspec.toml, then save each value in Doppler with secretspec set (docs/integrations/vaults/doppler.md)"
      : undefined;
  },
  itemNotes(refs, host) {
    const used = signedInWith(host);
    return used && refs.some((ref) => ref.kind === "doppler")
      ? [`keypin signs in to Doppler with ${used}`]
      : [];
  },
  prerequisites({ failures }, host) {
    if (!failures.length) return [];
    const fix = fixFor(failures, host);
    return [
      {
        name: "Doppler",
        status: "sign-in failed",
        fix,
        title: "Sign in to Doppler",
        body: [sentence(fix)],
        coversFailures: true,
      },
    ];
  },
};
