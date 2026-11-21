export const CLIENT_ID = "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID";
export const CLIENT_SECRET = "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET";
export const ACCESS_TOKENS = ["INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN", "INFISICAL_TOKEN"];
export const IDENTITY_ID = "KEYPIN_INFISICAL_IDENTITY_ID";
export const AUDIENCE = "KEYPIN_INFISICAL_AUDIENCE";
export const CONFIRMED_URL = "KEYPIN_INFISICAL_URL";
export const NO_CREDENTIALS = `set ${CLIENT_ID} and ${CLIENT_SECRET} to a machine identity's Universal Auth client ID and secret, or ${ACCESS_TOKENS.join(" or ")} to a machine identity's access token`;
export const ANOTHER_WAY = `or unset ${IDENTITY_ID} to sign in another way`;
export const NO_JOB_TOKEN = `give the GitHub Actions job permissions: id-token: write, ${ANOTHER_WAY}`;

export type Credentials =
  | { clientId: string; clientSecret: string }
  | { token: string; variable: string }
  | { identityId: string; audience: string | null; confirmedUrl: string | null }
  | { problem: string };

export function credentialsFrom(
  env: Readonly<Record<string, string | undefined>>,
): Credentials | null {
  const identityId = env[IDENTITY_ID] ?? "";
  if (identityId) {
    const others = [CLIENT_ID, CLIENT_SECRET, ...ACCESS_TOKENS].filter((name) => env[name]);
    const listed = others.join(" and ");
    if (others.length)
      return {
        problem: `both ${IDENTITY_ID} and ${listed} are set; unset ${listed} to sign in with GitHub Actions OIDC, or ${IDENTITY_ID} to sign in with ${others.length === 1 ? "it" : "them"}`,
      };
    return {
      identityId,
      audience: env[AUDIENCE] || null,
      confirmedUrl: env[CONFIRMED_URL] || null,
    };
  }
  const clientId = env[CLIENT_ID] ?? "";
  const clientSecret = env[CLIENT_SECRET] ?? "";
  if (clientId && clientSecret) return { clientId, clientSecret };
  const variable = ACCESS_TOKENS.find((name) => env[name]);
  const token = variable === undefined ? undefined : env[variable];
  return variable && token ? { token, variable } : null;
}
