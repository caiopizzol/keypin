import { isRecord, messageOf, SignInFailed } from "@keypin/core";
import type { Connect, SdkClient } from "./sdk";

const PREFIX = "ops_";
const SHARED_ADDRESSES = ["my.1password.com", "my.1password.ca", "my.1password.eu"];

export type TokenClient = (token: string) => Promise<SdkClient>;

export function signInAddress(token: string): string {
  const invalid = new Error(
    "OP_SERVICE_ACCOUNT_TOKEN isn't a 1Password service account token (they start with ops_)",
  );
  if (!token.startsWith(PREFIX)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  const address = isRecord(parsed) ? parsed.signInAddress : undefined;
  if (typeof address !== "string" || !address) throw invalid;
  return address.toLowerCase();
}

export function isSharedAddress(address: string): boolean {
  return SHARED_ADDRESSES.includes(address.toLowerCase());
}

const SIGN_IN_ADDRESS = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const ACCOUNT_ID = /^[a-z0-9]{26}$/i;

function isSignInAddress(account: string): boolean {
  return SIGN_IN_ADDRESS.test(account);
}

export function pinKind(account: string): "address" | "account ID" | "account name" {
  if (isSignInAddress(account)) return "address";
  return ACCOUNT_ID.test(account) ? "account ID" : "account name";
}

export function serviceAccountConnect(token: string, open: TokenClient): Connect {
  const address = signInAddress(token);
  let client: Promise<SdkClient> | undefined;
  return async (account) => {
    if (isSignInAddress(account) && account.toLowerCase() !== address) {
      throw new SignInFailed(
        `the service account signs in to ${address}, but keypin.toml pins ${account}`,
        { kind: "wrong-account", pinned: account, actual: address },
      );
    }
    client ??= open(token).catch((error: unknown) => {
      client = undefined;
      throw new Error(messageOf(error).replaceAll(token, "[the token]"));
    });
    return client;
  };
}
