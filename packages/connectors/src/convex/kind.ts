import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { ConvexEnvDestination, INVALIDATES } from "./convex";
import { convexDeploymentRules, type ConvexTarget } from "./rules";
import { convexSignIn, PERMISSION, SETTINGS_PAGE, signInProblem, TOKEN_VARIABLE } from "./token";

type Env = Readonly<Record<string, string | undefined>>;

export interface ConvexPublisher {
  signInEnv: Env;
}

export interface ConvexHost {
  readonly env: Env;
}

function prerequisites(env: Env): Prerequisite[] {
  if (env[TOKEN_VARIABLE]?.trim()) return [];
  return [
    {
      name: "Convex",
      status: "not logged in",
      fix: `set ${TOKEN_VARIABLE} to a Convex deploy key with ${PERMISSION} (${SETTINGS_PAGE})`,
      title: "Sign in to Convex",
      body: [sentence(signInProblem(env))],
      coversFailures: true,
    },
  ];
}

export const convexDeployment: DestinationKind<ConvexTarget, ConvexPublisher, ConvexHost> = {
  ...convexDeploymentRules,
  where: ({ account }) => `the Convex deployment ${account}`,
  login: () => `the deploy key in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: INVALIDATES,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  connect: ({ url }, { signInEnv }) =>
    new ConvexEnvDestination({ url, key: () => convexSignIn(signInEnv).key() }),
};
