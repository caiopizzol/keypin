export const TOKEN_VARIABLE = "DOPPLER_TOKEN";
export const IDENTITY_ID = "KEYPIN_DOPPLER_IDENTITY_ID";
export const AUDIENCE = "KEYPIN_DOPPLER_AUDIENCE";
export const NO_CREDENTIALS = `set ${TOKEN_VARIABLE} to a Doppler service token, service account token or personal token`;
export const ANOTHER_WAY = `or unset ${IDENTITY_ID} to sign in another way`;
export const NO_JOB_TOKEN = `give the GitHub Actions job permissions: id-token: write, ${ANOTHER_WAY}`;
export const IDENTITY_TOKEN = "service account identity token";

export type Credentials =
  | { token: string }
  | { identityId: string; audience: string | null }
  | { problem: string };

const TOKEN_KINDS: readonly [string, string][] = [
  ["dp.st.", "service token"],
  ["dp.sa.", "service account token"],
  ["dp.said.", IDENTITY_TOKEN],
  ["dp.pt.", "personal token"],
  ["dp.ct.", "CLI token"],
];

export function credentialsFrom(
  env: Readonly<Record<string, string | undefined>>,
): Credentials | null {
  const identityId = env[IDENTITY_ID]?.trim() ?? "";
  const token = env[TOKEN_VARIABLE]?.trim() ?? "";
  if (identityId && token)
    return {
      problem: `both ${IDENTITY_ID} and ${TOKEN_VARIABLE} are set; unset ${TOKEN_VARIABLE} to sign in with GitHub Actions OIDC, or ${IDENTITY_ID} to sign in with it`,
    };
  if (identityId) return { identityId, audience: env[AUDIENCE]?.trim() || null };
  return token ? { token } : null;
}

export function tokenKind(token: string): string {
  return TOKEN_KINDS.find(([prefix]) => token.startsWith(prefix))?.[1] ?? "token";
}

export const isServiceToken = (token: string) => token.startsWith("dp.st.");
