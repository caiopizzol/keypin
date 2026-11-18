import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { type Fetch, isRecord, parseObject, type Secret } from "@keypin/core";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SERVICE_ACCOUNTS = "https://console.cloud.google.com/iam-admin/serviceaccounts";
const LIFETIME = 3600;
const EARLY = 60_000;

export interface ServiceAccount {
  email: string;
  keyId: string | null;
  key: KeyObject;
}

export interface Refusal {
  facts: string;
  reason: string;
  fix: string;
}

export const OTHER_LOGINS: Record<string, string> = {
  authorized_user: "a gcloud user login (authorized_user)",
  external_account: "a workload identity federation config (external_account)",
  external_account_authorized_user: "a workforce identity login (external_account_authorized_user)",
  impersonated_service_account: "an impersonation config (impersonated_service_account)",
  gdch_service_account: "a Google Distributed Cloud key (gdch_service_account)",
};

export function adminFix(role: string): string {
  return `put a JSON key of a service account with the ${role} role in the admin item; create one at ${SERVICE_ACCOUNTS}`;
}

export function serviceAccount(admin: Secret, fix: string): ServiceAccount | Refusal {
  const json = parseObject(admin.reveal());
  const type = json.type;
  const other = typeof type === "string" ? OTHER_LOGINS[type] : undefined;
  if (other)
    return {
      facts: `the admin item holds ${other}`,
      reason: `keypin signs in to Google only with a service account key, so it runs without gcloud`,
      fix,
    };
  if (type !== "service_account")
    return {
      facts: "the admin item holds no service account key",
      reason: `keypin signs in to Google with a service account's JSON key, and the admin item holds another value`,
      fix,
    };
  const email = json.client_email;
  const pem = json.private_key;
  if (typeof email !== "string" || !email || typeof pem !== "string" || !pem)
    return {
      facts: "the admin item holds a service account key without client_email or private_key",
      reason: "keypin needs both to sign in to Google",
      fix,
    };
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    return {
      facts: `the admin item holds a key of service account ${email}`,
      reason: "its private_key isn't a private key keypin can read",
      fix: `copy the whole JSON key file into the admin item, or create a new key for ${email} at ${SERVICE_ACCOUNTS}`,
    };
  }
  const keyId = typeof json.private_key_id === "string" ? json.private_key_id : null;
  return { email, keyId, key };
}

export type AccessToken = { token: string; until: number } | Refusal;

export async function accessToken(
  fetch: Fetch,
  account: ServiceAccount,
  scope: string,
  now: Date,
): Promise<AccessToken> {
  const iat = Math.floor(now.getTime() / 1000);
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const header = encode({
    alg: "RS256",
    typ: "JWT",
    ...(account.keyId ? { kid: account.keyId } : {}),
  });
  const claims = encode({
    iss: account.email,
    scope,
    aud: TOKEN_URL,
    iat,
    exp: iat + LIFETIME,
  });
  const signed = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signed), account.key).toString("base64url");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signed}.${signature}`,
    }).toString(),
  });
  const body = parseObject(await response.text());
  const token = body.access_token;
  if (response.status === 200 && typeof token === "string" && token) {
    const seconds = typeof body.expires_in === "number" ? body.expires_in : LIFETIME;
    return { token, until: now.getTime() + seconds * 1000 - EARLY };
  }
  const error = isRecord(body) && typeof body.error === "string" ? body.error : null;
  if (response.status === 400 || response.status === 401)
    return {
      facts: `Google answered HTTP ${response.status}${error && /^[a-z_]+$/.test(error) ? ` ${error}` : ""}`,
      reason: `Google doesn't accept the key of service account ${account.email}: the key or the service account was deleted or disabled, or this computer's clock is off`,
      fix: `create a new JSON key for ${account.email} at ${SERVICE_ACCOUNTS} and put it in the admin item`,
    };
  throw new Error(`Google POST ${TOKEN_URL} returned HTTP ${response.status}`);
}

export interface SessionOptions {
  admin: () => Promise<Secret>;
  fetch: Fetch;
  now: () => Date;
  scope: string;
  fix: string;
}

export class Session {
  readonly #options: SessionOptions;
  #token: { token: string; until: number } | null = null;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  async account(): Promise<ServiceAccount | Refusal> {
    return serviceAccount(await this.#options.admin(), this.#options.fix);
  }

  async bearer(): Promise<string | Refusal> {
    const { fetch, now, scope } = this.#options;
    if (this.#token && this.#token.until > now().getTime()) return this.#token.token;
    const account = await this.account();
    if ("facts" in account) return account;
    const token = await accessToken(fetch, account, scope, now());
    if ("facts" in token) return token;
    this.#token = token;
    return token.token;
  }
}
