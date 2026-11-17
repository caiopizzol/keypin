export const TOKEN_VARIABLE = "KEYPIN_FLY_API_TOKEN";
export const TOKENS_PAGE = "https://fly.io/tokens";

export class FlySignInFailed extends Error {}

export interface FlySignIn {
  token(): Promise<string>;
}

export function flySignIn(env: Readonly<Record<string, string | undefined>>): FlySignIn {
  const value = env[TOKEN_VARIABLE];
  return {
    token: async () => {
      const token = value?.trim() ?? "";
      if (token) return token;
      throw new FlySignInFailed(signInProblem(env));
    },
  };
}

export function signInProblem(env: Readonly<Record<string, string | undefined>>): string {
  const set = env[TOKEN_VARIABLE] === undefined ? "isn't set" : "is set but empty";
  const ambient = ["FLY_API_TOKEN", "FLY_ACCESS_TOKEN"].filter((name) => env[name]);
  const note = ambient.length
    ? `; ${ambient.join(" and ")} ${ambient.length > 1 ? "are" : "is"} set, but keypin doesn't sign in with ${ambient.length > 1 ? "them" : "it"}, so ${ambient.length > 1 ? "they stay keys" : "it stays a key"} your map can hold`
    : "";
  return `keypin signs in to Fly.io with ${TOKEN_VARIABLE}, which ${set}${note}. Create a deploy token for the app with fly tokens create deploy -a <app>, or an org token with fly tokens create org (${TOKENS_PAGE}), and set ${TOKEN_VARIABLE}; keypin doesn't read the fly login`;
}
