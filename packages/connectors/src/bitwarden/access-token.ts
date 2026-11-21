import { accessTokenKey, type Key } from "./crypto";
import { UUID } from "./reference";

export const ACCESS_TOKEN = "BWS_ACCESS_TOKEN";
export const NO_CREDENTIALS = `set ${ACCESS_TOKEN} to a machine account's access token`;

export interface AccessToken {
  id: string;
  secret: string;
  key: Key;
}

export function accessTokenFrom(
  env: Readonly<Record<string, string | undefined>>,
): AccessToken | string | null {
  const text = env[ACCESS_TOKEN] ?? "";
  if (text === "") return null;
  const [head = "", seed = "", ...more] = text.split(":");
  const [version, id = "", secret = "", ...extra] = head.split(".");
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(seed)
    ? accessTokenKey(Buffer.from(seed, "base64"))
    : null;
  if (version !== "0" || more.length || extra.length || !UUID.test(id) || !secret || !key)
    return `${ACCESS_TOKEN} isn't a Bitwarden Secrets Manager access token, which looks like 0.<id>.<secret>:<key>; copy it again from the machine account's Access tokens tab`;
  return { id, secret, key };
}
