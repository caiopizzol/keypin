import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { FlySecretsDestination, refusedName, STAGED } from "./fly";
import { flySignIn, signInProblem, TOKEN_VARIABLE, TOKENS_PAGE } from "./token";

export type FlyTarget = {
  to: "fly-app";
  account: string;
  app: string;
  org?: string;
};

type Env = Readonly<Record<string, string | undefined>>;

export interface FlyPublisher {
  signInEnv: Env;
}

export interface FlyHost {
  readonly env: Env;
}

const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ORG = /^[a-z0-9][a-z0-9-]*$/;

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
  kind: "fly-app",
  label: "Fly.io",
  parse(read) {
    read.only(["app", "org"]);
    const app = read.filledIn(read.required("app"), "app", "the Fly.io app's name, from fly.toml");
    const org = read.filledIn(
      read.optional("org"),
      "org",
      "the slug of the Fly.io organization that owns the app, from fly orgs list",
    );
    if (app !== undefined && !APP.test(app))
      read.fail(`field "app" must be a Fly.io app name: lowercase letters, digits and "-"`);
    if (org !== undefined && !ORG.test(org))
      read.fail(
        `field "org" must be a Fly.io organization slug: lowercase letters, digits and "-"`,
      );
    if (app === undefined) return undefined;
    const target: FlyTarget = { to: "fly-app", account: app, app };
    return org === undefined ? target : { ...target, org };
  },
  id: ({ app }) => app,
  secretId: ({ app }, secretName) => `${app}:${secretName}`,
  checkId: ({ app, org }) => (org === undefined ? app : `${org}/${app}`),
  fromId: (id) => (APP.test(id) ? { to: "fly-app", account: id, app: id } : undefined),
  describe: ({ app }) => app,
  named: ({ app }) => `the secrets of Fly.io app ${app}`,
  where: ({ app }) => `the Fly.io app ${app}`,
  login: () => `the token in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: STAGED,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  refuses: refusedName,
  connect: ({ app, org }, { signInEnv }) =>
    new FlySecretsDestination({ app, org, token: () => flySignIn(signInEnv).token() }),
};
