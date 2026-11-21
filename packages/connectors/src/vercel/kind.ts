import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { type VercelTarget, vercelProjectRules } from "./rules";
import { signInProblem, TOKEN_VARIABLE, TOKENS_PAGE, vercelSignIn } from "./token";
import { REDEPLOY, VercelEnvDestination } from "./vercel";

type Env = Readonly<Record<string, string | undefined>>;

export interface VercelPublisher {
  signInEnv: Env;
}

export interface VercelHost {
  readonly env: Env;
}

function prerequisites(env: Env): Prerequisite[] {
  if (env[TOKEN_VARIABLE]?.trim()) return [];
  return [
    {
      name: "Vercel",
      status: "not logged in",
      fix: `set ${TOKEN_VARIABLE} to a Vercel token (${TOKENS_PAGE})`,
      title: "Sign in to Vercel",
      body: [sentence(signInProblem(env))],
      coversFailures: true,
    },
  ];
}

export const vercelProject: DestinationKind<VercelTarget, VercelPublisher, VercelHost> = {
  ...vercelProjectRules,
  where: ({ project, environment }) => `the Vercel project ${project} (${environment})`,
  login: () => `the token in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: REDEPLOY,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  connect: ({ account, project, environment }, { signInEnv }) =>
    new VercelEnvDestination({
      team: account,
      project,
      environment,
      token: () => vercelSignIn(signInEnv).token(),
    }),
};
