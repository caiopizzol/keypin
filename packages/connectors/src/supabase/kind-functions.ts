import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { TOKENS } from "./api";
import { LIVE, SupabaseSecretsDestination } from "./functions";
import { supabaseFunctionsRules, type SupabaseFunctionsTarget } from "./rules";
import { signInProblem, supabaseSignIn, TOKEN_VARIABLE } from "./token";

type Env = Readonly<Record<string, string | undefined>>;

export interface SupabasePublisher {
  signInEnv: Env;
}

export interface SupabaseHost {
  readonly env: Env;
}

function prerequisites(env: Env): Prerequisite[] {
  if (env[TOKEN_VARIABLE]?.trim()) return [];
  return [
    {
      name: "Supabase",
      status: "not logged in",
      fix: `set ${TOKEN_VARIABLE} to a Supabase personal access token (${TOKENS})`,
      title: "Sign in to Supabase",
      body: [sentence(signInProblem(env))],
      coversFailures: true,
    },
  ];
}

export const supabaseFunctions: DestinationKind<
  SupabaseFunctionsTarget,
  SupabasePublisher,
  SupabaseHost
> = {
  ...supabaseFunctionsRules,
  where: ({ account }) => `the Supabase project ${account}`,
  login: () => `the token in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: LIVE,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  connect: ({ account }, { signInEnv }) =>
    new SupabaseSecretsDestination({
      projectRef: account,
      token: () => supabaseSignIn(signInEnv).token(),
    }),
};
