import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { FlySecretsDestination, STAGED } from "./fly";
import { flyAppRules, type FlyTarget } from "./rules";
import { flySignIn, signInProblem, TOKEN_VARIABLE, TOKENS_PAGE } from "./token";

type Env = Readonly<Record<string, string | undefined>>;

export interface FlyPublisher {
  signInEnv: Env;
}

export interface FlyHost {
  readonly env: Env;
}

function prerequisites(env: Env): Prerequisite[] {
  if (env[TOKEN_VARIABLE]?.trim()) return [];
  return [
    {
      name: "Fly.io",
      status: "not logged in",
      fix: `set ${TOKEN_VARIABLE} to a Fly.io deploy or org token (${TOKENS_PAGE})`,
      title: "Sign in to Fly.io",
      body: [sentence(signInProblem(env))],
      coversFailures: true,
    },
  ];
}

export const flyApp: DestinationKind<FlyTarget, FlyPublisher, FlyHost> = {
  ...flyAppRules,
  where: ({ app }) => `the Fly.io app ${app}`,
  login: () => `the token in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: STAGED,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  connect: ({ app, org }, { signInEnv }) =>
    new FlySecretsDestination({ app, org, token: () => flySignIn(signInEnv).token() }),
};
