import { isRecord } from "@keypin/core";
import type { Connect, SdkClient } from "./sdk";

const PREFIX = "ops_";
const SHARED_ADDRESS = "my.1password.com";

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
  return address.toLowerCase() === SHARED_ADDRESS;
}

export function serviceAccountConnect(token: string, open: TokenClient): Connect {
  const address = signInAddress(token);
  let client: Promise<SdkClient> | undefined;
  return async (account) => {
    if (!account.includes(".")) {
      throw new Error(
        `keypin.toml pins the account ID ${account}, which a service account can't be checked against; pin its sign-in address, ${address}, for service-account mode`,
      );
    }
    if (account.toLowerCase() !== address) {
      throw new Error(
        `the service account signs in to ${address}, but keypin.toml pins ${account}`,
      );
    }
    client ??= open(token).catch((error: unknown) => {
      client = undefined;
      throw new Error(messageOf(error).replaceAll(token, "[the token]"));
    });
    return client;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
