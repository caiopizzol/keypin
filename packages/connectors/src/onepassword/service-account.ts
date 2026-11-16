import { isRecord, messageOf, SignInFailed } from "@keypin/core";
import { type Connect, RateLimited, type SdkClient } from "./sdk";

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
  const host = typeof address === "string" ? pinnedAddress(address) : "";
  if (!host) throw invalid;
  return host;
}

export function isSharedAddress(address: string): boolean {
  return SHARED_ADDRESSES.includes(address.toLowerCase());
}

const ACCOUNT_ID = /^[a-z0-9]{26}$/i;

export function pinKind(account: string): "address" | "account ID" | "account name" {
  const pin = account.trim();
  const dotted = /\s/.test(pin) ? /[^\s.]\.[^\s.]/.test(pin) : pin.includes(".");
  if (dotted || pin.includes("://")) return "address";
  return ACCOUNT_ID.test(pin) ? "account ID" : "account name";
}

export function pinnedAddress(account: string): string {
  const host = account.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return (host.split(/[/?#]/)[0] ?? "").toLowerCase();
}

export function serviceAccountConnect(token: string, open: TokenClient): Connect {
  const address = signInAddress(token);
  let client: Promise<SdkClient> | undefined;
  return async (account) => {
    if (pinKind(account) === "address" && pinnedAddress(account) !== address) {
      throw new SignInFailed(
        `the service account signs in to ${address}, but keypin.toml pins ${account}`,
        { kind: "wrong-account", pinned: account, actual: address },
      );
    }
    client ??= open(token).catch((error: unknown) => {
      client = undefined;
      const message = messageOf(error).replaceAll(token, "[the token]");
      throw error instanceof RateLimited ? new RateLimited(message) : new Error(message);
    });
    return client;
  };
}
