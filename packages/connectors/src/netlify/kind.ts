import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { NetlifyEnvDestination, REBUILD } from "./netlify";
import { type NetlifyTarget, netlifyProjectRules } from "./rules";
import { netlifySignIn, signInProblem, TOKEN_VARIABLE, TOKENS_PAGE } from "./token";

type Env = Readonly<Record<string, string | undefined>>;

export interface NetlifyPublisher {
  signInEnv: Env;
}

export interface NetlifyHost {
  readonly env: Env;
}

function prerequisites(env: Env): Prerequisite[] {
  if (env[TOKEN_VARIABLE]?.trim()) return [];
  return [
    {
      name: "Netlify",
      status: "not logged in",
      fix: `set ${TOKEN_VARIABLE} to a Netlify personal access token (${TOKENS_PAGE})`,
      title: "Sign in to Netlify",
      body: [sentence(signInProblem(env))],
      coversFailures: true,
    },
  ];
}

export const netlifyProject: DestinationKind<NetlifyTarget, NetlifyPublisher, NetlifyHost> = {
  ...netlifyProjectRules,
  where: ({ project, context }) => `the Netlify project ${project} (${context})`,
  login: () => `the token in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: REBUILD,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  connect: ({ account, project, context }, { signInEnv }) =>
    new NetlifyEnvDestination({
      team: account,
      project,
      context,
      token: () => netlifySignIn(signInEnv).token(),
    }),
};
