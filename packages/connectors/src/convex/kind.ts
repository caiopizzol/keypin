import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { ConvexEnvDestination, deploymentOf, INVALIDATES, refusedName } from "./convex";
import { convexSignIn, PERMISSION, SETTINGS_PAGE, signInProblem, TOKEN_VARIABLE } from "./token";

export type ConvexTarget = {
  to: "convex-deployment";
  account: string;
  url: string;
};

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

const host = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");

export const convexDeployment: DestinationKind<ConvexTarget, ConvexPublisher, ConvexHost> = {
  kind: "convex-deployment",
  label: "Convex",
  parse(read) {
    read.only(["url"]);
    const url = read.filledIn(
      read.required("url"),
      "url",
      "the Convex deployment's URL, such as https://happy-animal-123.convex.cloud, from its settings",
    );
    if (url === undefined) return undefined;
    const account = deploymentOf(url);
    if (!account) {
      read.fail(
        `field "url" must be the deployment's convex.cloud URL, such as https://happy-animal-123.convex.cloud`,
      );
      return undefined;
    }
    return { to: "convex-deployment", account, url: `https://${host(url)}` };
  },
  id: ({ url }) => host(url),
  secretId: ({ url }, secretName) => `${host(url)}:${secretName}`,
  checkId: ({ url }) => host(url),
  fromId(id) {
    const url = `https://${id}`;
    const account = deploymentOf(url);
    return account ? { to: "convex-deployment", account, url } : undefined;
  },
  describe: ({ account }) => account,
  named: ({ account }) => `the environment variables of Convex deployment ${account}`,
  where: ({ account }) => `the Convex deployment ${account}`,
  login: () => `the deploy key in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: INVALIDATES,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  refuses: refusedName,
  connect: ({ url }, { signInEnv }) =>
    new ConvexEnvDestination({ url, key: () => convexSignIn(signInEnv).key() }),
};
