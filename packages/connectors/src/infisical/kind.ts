import { type SignInReason, sentence, type VaultKind } from "@keypin/core";
import {
  ACCESS_TOKENS,
  CLIENT_ID,
  CLIENT_SECRET,
  credentialsFrom,
  NO_CREDENTIALS,
} from "./backend";
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

export interface InfisicalHost {
  readonly env: Readonly<Record<string, string | undefined>>;
}

function fixFor(failures: readonly SignInReason[], { env }: InfisicalHost): string {
  if (failures.some((reason) => reason.kind === "no-credentials"))
    return `${NO_CREDENTIALS} (docs/infisical.md)`;
  if (failures.some((reason) => reason.kind === "wrong-account"))
    return "use a machine identity from the organization keypin.toml pins under [infisical]";
  const credentials = credentialsFrom(env);
  const variables =
    credentials && "variable" in credentials
      ? credentials.variable
      : `${CLIENT_ID}, ${CLIENT_SECRET}`;
  return `check ${variables} and the url under [infisical] in keypin.toml`;
}

function signedInWith({ env }: InfisicalHost): string | null {
  const credentials = credentialsFrom(env);
  if (!credentials) return null;
  if ("variable" in credentials) return `the access token in ${credentials.variable}`;
  const ignored = ACCESS_TOKENS.filter((name) => env[name]);
  return `the Universal Auth client ID and secret${ignored.length ? `, not ${ignored.join(" or ")}` : ""}`;
}

export const infisicalVault: VaultKind<
  InfisicalHost,
  InfisicalRef,
  InfisicalReference,
  InfisicalPin
> = {
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
  signInVariables: [CLIENT_ID, CLIENT_SECRET, ...ACCESS_TOKENS],
  addByHand: (map) => {
    const refs = map.keys.flatMap((key) =>
      Object.values(key.environments).flatMap((entry) => (entry ? [entry.ref] : [])),
    );
    return map.pins.infisical !== undefined && refs.every((ref) => ref.kind === "infisical")
      ? `add the secrets in Infisical and map them with ${SCHEME} references (docs/infisical.md)`
      : undefined;
  },
  itemNotes(refs, host) {
    const used = signedInWith(host);
    return used && refs.some((ref) => ref.kind === "infisical")
      ? [`keypin signs in to Infisical with ${used}`]
      : [];
  },
  prerequisites({ failures }, host) {
    if (!failures.length) return [];
    const fix = fixFor(failures, host);
    return [
      {
        name: "Infisical",
        status: "sign-in failed",
        fix,
        title: "Sign in to Infisical",
        body: [sentence(fix)],
        coversFailures: true,
      },
    ];
  },
};
