import type { DestinationRules } from "@keypin/core";

const NAME = /^[A-Za-z0-9_]+$/;

export function refusedName(name: string): string | undefined {
  return NAME.test(name) ? undefined : "Fly.io names use only letters, digits and _";
}

export type FlyTarget = {
  to: "fly-app";
  account: string;
  app: string;
  org?: string;
};

const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ORG = /^[a-z0-9][a-z0-9-]*$/;

export const flyAppRules: DestinationRules<FlyTarget> = {
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
  refuses: refusedName,
};
