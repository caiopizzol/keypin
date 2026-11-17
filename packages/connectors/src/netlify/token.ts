export const TOKEN_VARIABLE = "KEYPIN_NETLIFY_TOKEN";
export const TOKENS_PAGE = "https://app.netlify.com/user/applications#personal-access-tokens";

export class NetlifySignInFailed extends Error {}

export interface NetlifySignIn {
  token(): Promise<string>;
}

export function netlifySignIn(env: Readonly<Record<string, string | undefined>>): NetlifySignIn {
  const value = env[TOKEN_VARIABLE];
  return {
    token: async () => {
      const token = value?.trim() ?? "";
      if (token) return token;
      throw new NetlifySignInFailed(signInProblem(env));
    },
  };
}

export function signInProblem(env: Readonly<Record<string, string | undefined>>): string {
  const set = env[TOKEN_VARIABLE] === undefined ? "isn't set" : "is set but empty";
  const ambient = env.NETLIFY_AUTH_TOKEN
    ? `; NETLIFY_AUTH_TOKEN is set, but keypin doesn't sign in with it, so it stays a key your map can hold`
    : "";
  return `keypin signs in to Netlify with ${TOKEN_VARIABLE}, which ${set}${ambient}. Create a personal access token at ${TOKENS_PAGE} and set ${TOKEN_VARIABLE}; keypin doesn't read the netlify login`;
}
