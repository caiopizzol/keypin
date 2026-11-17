export const TOKEN_VARIABLE = "KEYPIN_VERCEL_TOKEN";
export const TOKENS_PAGE = "https://vercel.com/account/tokens";

export class VercelSignInFailed extends Error {}

export interface VercelSignIn {
  token(): Promise<string>;
}

export function vercelSignIn(env: Readonly<Record<string, string | undefined>>): VercelSignIn {
  const value = env[TOKEN_VARIABLE];
  return {
    token: async () => {
      const token = value?.trim() ?? "";
      if (token) return token;
      throw new VercelSignInFailed(signInProblem(env));
    },
  };
}

export function signInProblem(env: Readonly<Record<string, string | undefined>>): string {
  const set = env[TOKEN_VARIABLE] === undefined ? "isn't set" : "is set but empty";
  const ambient = env.VERCEL_TOKEN
    ? `; VERCEL_TOKEN is set, but keypin doesn't sign in with it, so it stays a key your map can hold`
    : "";
  return `keypin signs in to Vercel with ${TOKEN_VARIABLE}, which ${set}${ambient}. Create a token at ${TOKENS_PAGE} for the project's team and set ${TOKEN_VARIABLE}; keypin doesn't read the vercel login`;
}
