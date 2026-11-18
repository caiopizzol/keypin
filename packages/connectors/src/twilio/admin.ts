import { parseObject, type Secret } from "@keypin/core";

export const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
export const KEY_SID = /^SK[0-9a-fA-F]{32}$/;
export const DASHBOARD = "https://console.twilio.com/us1/account/keys-credentials/api-keys";
export const MANAGE = [
  "/twilio/iam/api-keys/create",
  "/twilio/iam/api-keys/read",
  "/twilio/iam/api-keys/delete",
];

export const ADMIN_FIX = `put JSON in the admin item with TWILIO_ACCOUNT_SID and either TWILIO_AUTH_TOKEN, or TWILIO_API_KEY and TWILIO_API_SECRET of a Main key or a Restricted key that may create, read and delete API keys (${DASHBOARD})`;

export interface Refusal {
  facts: string;
  reason: string;
  fix: string;
}

export interface Admin {
  account: string;
  user: string;
  password: string;
  key: string | null;
}

export function adminCredentials(admin: Secret): Admin | Refusal {
  const json = parseObject(admin.reveal());
  const field = (name: string) => {
    const value = json[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const account = field("TWILIO_ACCOUNT_SID");
  const token = field("TWILIO_AUTH_TOKEN");
  const key = field("TWILIO_API_KEY");
  const secret = field("TWILIO_API_SECRET");
  const refuse = (facts: string, reason: string): Refusal => ({ facts, reason, fix: ADMIN_FIX });
  if (!account)
    return refuse(
      "the admin item holds no TWILIO_ACCOUNT_SID",
      "Twilio makes a key for an account, so keypin needs the account's SID with the admin credential",
    );
  if (!ACCOUNT_SID.test(account))
    return refuse(
      "the admin item's TWILIO_ACCOUNT_SID isn't an Account SID",
      "an Account SID starts with AC and has 34 characters",
    );
  if (token && (key || secret))
    return refuse(
      "the admin item holds both TWILIO_AUTH_TOKEN and an API key",
      "keypin signs in with one admin credential, so keep only the one it should use",
    );
  if (token) return { account, user: account, password: token, key: null };
  if (!key || !secret)
    return refuse(
      "the admin item holds no TWILIO_AUTH_TOKEN, and no TWILIO_API_KEY with TWILIO_API_SECRET",
      "keypin signs in to Twilio with the account's auth token or an API key",
    );
  if (!KEY_SID.test(key))
    return refuse(
      "the admin item's TWILIO_API_KEY isn't an API key SID",
      "an API key SID starts with SK and has 34 characters",
    );
  return { account, user: key, password: secret, key };
}
