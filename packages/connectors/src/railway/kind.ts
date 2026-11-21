import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { RailwayVariablesDestination, REDEPLOY } from "./railway";
import { type RailwayTarget, railwayServiceRules } from "./rules";
import { railwaySignIn, signInProblem, TOKEN_VARIABLE, TOKENS_PAGE } from "./token";

type Env = Readonly<Record<string, string | undefined>>;

export interface RailwayPublisher {
  signInEnv: Env;
}

export interface RailwayHost {
  readonly env: Env;
}

function prerequisites(env: Env): Prerequisite[] {
  if (env[TOKEN_VARIABLE]?.trim()) return [];
  return [
    {
      name: "Railway",
      status: "not logged in",
      fix: `set ${TOKEN_VARIABLE} to a Railway token (${TOKENS_PAGE})`,
      title: "Sign in to Railway",
      body: [sentence(signInProblem(env))],
      coversFailures: true,
    },
  ];
}

export const railwayService: DestinationKind<RailwayTarget, RailwayPublisher, RailwayHost> = {
  ...railwayServiceRules,
  where: ({ environment, service }) => `the Railway service ${service} (${environment})`,
  login: () => `the token in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: REDEPLOY,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  connect: ({ account, environment, service }, { signInEnv }) =>
    new RailwayVariablesDestination({
      project: account,
      environment,
      service,
      token: () => railwaySignIn(signInEnv).token(),
    }),
};
