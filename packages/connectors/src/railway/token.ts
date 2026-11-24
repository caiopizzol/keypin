export const TOKEN_VARIABLE = "KEYPIN_RAILWAY_TOKEN";
export const TOKENS_PAGE = "https://railway.com/account/tokens";

export class RailwaySignInFailed extends Error {}

interface RailwaySignIn {
  token(): Promise<string>;
}

export function railwaySignIn(env: Readonly<Record<string, string | undefined>>): RailwaySignIn {
  const value = env[TOKEN_VARIABLE];
  return {
    token: async () => {
      const token = value?.trim() ?? "";
      if (token) return token;
      throw new RailwaySignInFailed(signInProblem(env));
    },
  };
}

export function signInProblem(env: Readonly<Record<string, string | undefined>>): string {
  const set = env[TOKEN_VARIABLE] === undefined ? "isn't set" : "is set but empty";
  const ambient = ["RAILWAY_TOKEN", "RAILWAY_API_TOKEN"].filter((name) => env[name]);
  const note = ambient.length
    ? `; ${ambient.join(" and ")} ${ambient.length > 1 ? "are" : "is"} set, but keypin doesn't sign in with ${ambient.length > 1 ? "them" : "it"}, so ${ambient.length > 1 ? "they stay keys" : "it stays a key"} your map can hold`
    : "";
  return `keypin signs in to Railway with ${TOKEN_VARIABLE}, which ${set}${note}. Create a workspace or account token at ${TOKENS_PAGE}, or a project token for the environment in the project's settings, and set ${TOKEN_VARIABLE}; keypin doesn't read the railway login`;
}
