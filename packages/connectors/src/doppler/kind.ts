import { type SignInReason, sentence, type VaultKind } from "@keypin/core";
import { NO_CREDENTIALS, TOKEN_VARIABLE, tokenFrom, tokenKind } from "./backend";
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

export interface DopplerHost {
  readonly env: Readonly<Record<string, string | undefined>>;
}

function fixFor(failures: readonly SignInReason[]): string {
  if (failures.some((reason) => reason.kind === "no-credentials"))
    return `${NO_CREDENTIALS} (docs/doppler.md)`;
  if (failures.some((reason) => reason.kind === "wrong-account"))
    return `use a token from the workplace keypin.toml pins under [doppler]`;
  return `check ${TOKEN_VARIABLE} and the workplace under [doppler] in keypin.toml`;
}

export const dopplerVault: VaultKind<DopplerHost, DopplerRef, DopplerReference, DopplerPin> = {
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
  signInVariables: [TOKEN_VARIABLE],
  newValueByHand: "Put a new value in the Doppler secret",
  addRotatedDate:
    "Doppler keeps no rotated date on a secret, so keypin can't tell when this key is due (docs/doppler.md).",
  addByHand: (map) => {
    const refs = map.keys.flatMap((key) =>
      Object.values(key.environments).flatMap((entry) => (entry ? [entry.ref] : [])),
    );
    return map.pins.doppler !== undefined && refs.every((ref) => ref.kind === "doppler")
      ? `add the secrets in Doppler and map them with ${SCHEME} references (docs/doppler.md)`
      : undefined;
  },
  itemNotes(refs, { env }) {
    const token = tokenFrom(env);
    return token && refs.some((ref) => ref.kind === "doppler")
      ? [`keypin signs in to Doppler with the ${tokenKind(token)} in ${TOKEN_VARIABLE}`]
      : [];
  },
  prerequisites({ failures }) {
    if (!failures.length) return [];
    const fix = fixFor(failures);
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
