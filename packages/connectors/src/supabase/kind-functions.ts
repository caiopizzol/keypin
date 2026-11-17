import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { TOKENS } from "./api";
import { LIVE, REF, refusedName, SupabaseSecretsDestination } from "./functions";
import { signInProblem, supabaseSignIn, TOKEN_VARIABLE } from "./token";

export type SupabaseFunctionsTarget = {
  to: "supabase-functions";
  account: string;
};

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
  kind: "supabase-functions",
  label: "Supabase",
  parse(read) {
    read.only(["project_ref"]);
    const ref = read.filledIn(
      read.required("project_ref"),
      "project_ref",
      "the Supabase project ref, from its dashboard URL",
    );
    if (ref !== undefined && !REF.test(ref)) {
      read.fail(`field "project_ref" must be the project's 20-letter ref, from its dashboard URL`);
      return undefined;
    }
    return ref === undefined ? undefined : { to: "supabase-functions", account: ref };
  },
  id: ({ account }) => account,
  secretId: ({ account }, secretName) => `${account}:${secretName}`,
  checkId: ({ account }) => account,
  fromId: (id) => (REF.test(id) ? { to: "supabase-functions", account: id } : undefined),
  describe: ({ account }) => account,
  named: ({ account }) => `the Edge Function secrets of Supabase project ${account}`,
  where: ({ account }) => `the Supabase project ${account}`,
  login: () => `the token in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: LIVE,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  refuses: refusedName,
  connect: ({ account }, { signInEnv }) =>
    new SupabaseSecretsDestination({
      projectRef: account,
      token: () => supabaseSignIn(signInEnv).token(),
    }),
};
