import type { KeyRef, KeysMap, VaultBackend } from "@keypin/core";
import {
  type Connect,
  onePasswordBackend,
  serviceAccountConnect,
  type SignIn,
  signInAddress,
  type TokenClient,
} from "@keypin/connectors/onepassword";
import { type Deps, UsageError } from "./deps";

export type { SignIn };

export const APPROVE = "1Password may be asking you to approve keypin";

export function onePasswordFrom(
  env: Readonly<Record<string, string | undefined>>,
  open: { desktop: Connect; token: TokenClient },
): { signIn: SignIn; vault: VaultBackend } {
  const mode = env.KEYPIN_1PASSWORD ?? "";
  const token = env.OP_SERVICE_ACCOUNT_TOKEN ?? "";
  if (mode === "" || mode === "desktop")
    return {
      signIn: { mode: "desktop", tokenIgnored: mode === "" && token !== "" },
      vault: onePasswordBackend(open.desktop),
    };
  if (mode !== "service-account")
    throw new UsageError("KEYPIN_1PASSWORD must be desktop or service-account");
  if (token === "")
    throw new Error(
      "KEYPIN_1PASSWORD=service-account needs the service account's token in OP_SERVICE_ACCOUNT_TOKEN, which is unset or empty",
    );
  return {
    signIn: { mode: "service-account", address: signInAddress(token) },
    vault: onePasswordBackend(serviceAccountConnect(token, open.token), "service-account"),
  };
}

export function signInFor(deps: Pick<Deps, "signIn">, refs: readonly KeyRef[]): SignIn | null {
  return refs.some((ref) => ref.kind === "1password") ? deps.signIn() : null;
}

export function mapSignIn(
  deps: Pick<Deps, "signIn">,
  map: KeysMap | null,
  refs: readonly KeyRef[],
): SignIn | null {
  const infisicalOnly = map?.pins.infisical && !map.pins["1password"];
  return refs.length || infisicalOnly ? signInFor(deps, refs) : deps.signIn();
}

export function approval(deps: Pick<Deps, "signIn">, refs: readonly KeyRef[]): string | undefined {
  return signInFor(deps, refs)?.mode === "desktop" ? APPROVE : undefined;
}
