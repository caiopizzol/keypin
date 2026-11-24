import { TOKENS } from "./api";

export const TOKEN_VARIABLE = "KEYPIN_SUPABASE_ACCESS_TOKEN";

export class SupabaseSignInFailed extends Error {}

interface SupabaseSignIn {
  token(): Promise<string>;
}

export function supabaseSignIn(env: Readonly<Record<string, string | undefined>>): SupabaseSignIn {
  const value = env[TOKEN_VARIABLE];
  return {
    token: async () => {
      const token = value?.trim() ?? "";
      if (token) return token;
      throw new SupabaseSignInFailed(signInProblem(env));
    },
  };
}

export function signInProblem(env: Readonly<Record<string, string | undefined>>): string {
  const set = env[TOKEN_VARIABLE] === undefined ? "isn't set" : "is set but empty";
  const ambient = env.SUPABASE_ACCESS_TOKEN
    ? "; SUPABASE_ACCESS_TOKEN is set, but keypin doesn't sign in with it, so it stays a key your map can hold"
    : "";
  return `keypin signs in to Supabase with ${TOKEN_VARIABLE}, which ${set}${ambient}. Create a personal access token at ${TOKENS} with Edge Function Secrets Read-write on the project and set ${TOKEN_VARIABLE}; keypin doesn't read the supabase login`;
}
