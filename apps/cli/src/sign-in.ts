import type { VaultBackend } from "@keypin/core";
import {
  type Connect,
  onePasswordBackend,
  serviceAccountConnect,
  signInAddress,
  type TokenClient,
} from "@keypin/vault-1password";
import { type Deps, UsageError } from "./deps";

export type SignIn =
  | { mode: "desktop"; tokenIgnored: boolean }
  | { mode: "service-account"; address: string };

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

export function approval(deps: Pick<Deps, "signIn">): string | undefined {
  return deps.signIn().mode === "desktop" ? APPROVE : undefined;
}
