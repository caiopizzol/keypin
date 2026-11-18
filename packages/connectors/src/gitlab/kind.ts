import { type DestinationKind, type Prerequisite, type TableReader } from "@keypin/core";
import {
  DEFAULT_HOST,
  GitLabVariablesDestination,
  HOST,
  NAME,
  NEXT_PIPELINE,
  type Owner,
  PATH,
} from "./gitlab";
import { findGlab, gitlabSignIn, TOKEN_VARIABLE, tokensPage } from "./token";

export type GitLabProjectTarget = {
  to: "gitlab-project";
  account: string;
  project: string;
  host?: string;
  environment_scope?: string;
};

export type GitLabGroupTarget = {
  to: "gitlab-group";
  account: string;
  group: string;
  host?: string;
};

type Env = Readonly<Record<string, string | undefined>>;

export interface GitLabPublisher {
  signInEnv: Env;
  signInVariables: readonly string[];
}

export interface GitLabHost {
  readonly env: Env;
}

const SCOPE = /^[A-Za-z0-9 _./${}*-]{1,255}$/;
const ID = /^([^@#]+)(?:@([^@#]+))?(?:#(.+))?$/;

function prerequisites(env: Env): Prerequisite[] {
  if (env[TOKEN_VARIABLE] !== undefined || findGlab(env.PATH ?? "")) return [];
  return [
    {
      name: "GitLab",
      status: "not logged in",
      fix: `install glab and run glab auth login, or set ${TOKEN_VARIABLE} to a GitLab access token with the api scope`,
      title: "Sign in to GitLab",
      body: [
        "Install glab (https://gitlab.com/gitlab-org/cli), then run:",
        "  glab auth login",
        `Or set ${TOKEN_VARIABLE} to a personal, project or group access token with the api scope (${tokensPage(DEFAULT_HOST)}).`,
      ],
      coversFailures: true,
    },
  ];
}

function readPlace(read: TableReader, owner: Owner, fields: readonly string[]) {
  read.only([owner, "host", ...fields]);
  const path = read.filledIn(
    read.required(owner),
    owner,
    `the GitLab ${owner}'s full path, such as "${owner === "project" ? "acme/billing" : "acme"}"`,
  );
  if (path !== undefined && !PATH.test(path))
    read.fail(`field "${owner}" must be the ${owner}'s full path, such as "acme/billing"`);
  const host = read.filledIn(
    read.optional("host"),
    "host",
    "the GitLab host, such as gitlab.example.com",
  );
  if (host !== undefined && !HOST.test(host))
    read.fail(`field "host" must be a host name, such as gitlab.example.com, without https://`);
  const account = path?.split("/")[0];
  return { path, account, host: host === DEFAULT_HOST ? undefined : host };
}

function signIn(host: string | undefined, { signInEnv, signInVariables }: GitLabPublisher) {
  return gitlabSignIn({ env: signInEnv, signIn: signInVariables, host: host ?? DEFAULT_HOST });
}

const at = (host: string | undefined) => (host === undefined ? "" : ` on ${host}`);
const placeOf = (path: string, host?: string, scope?: string) =>
  `${path}${host === undefined ? "" : `@${host}`}${scope === undefined ? "" : `#${scope}`}`;
const folded = (path: string, host?: string) => `${host ?? DEFAULT_HOST}/${path.toLowerCase()}`;

function parseId(id: string) {
  const [, path, host, scope] = ID.exec(id) ?? [];
  return path !== undefined && PATH.test(path) ? { path, host, scope } : undefined;
}

export const gitlabProject: DestinationKind<GitLabProjectTarget, GitLabPublisher, GitLabHost> = {
  kind: "gitlab-project",
  label: "GitLab",
  parse(read) {
    const { path, account, host } = readPlace(read, "project", ["environment_scope"]);
    const scope = read.filledIn(
      read.optional("environment_scope"),
      "environment_scope",
      `the GitLab environment the variable is for, such as "production", or "*" for all`,
    );
    if (scope !== undefined && !SCOPE.test(scope))
      read.fail(
        `field "environment_scope" must be a GitLab environment name or wildcard, such as "production" or "review/*"`,
      );
    if (path === undefined || account === undefined) return undefined;
    const target: GitLabProjectTarget = { to: "gitlab-project", account, project: path };
    if (host !== undefined) target.host = host;
    if (scope !== undefined && scope !== "*") target.environment_scope = scope;
    return target;
  },
  id: ({ project, host, environment_scope }) => placeOf(project, host, environment_scope),
  secretId: ({ project, host, environment_scope }, secretName) =>
    `${folded(project, host)}#${environment_scope ?? "*"}:${secretName}`,
  checkId: ({ project, host }) => folded(project, host),
  fromId(id, pinned) {
    const found = parseId(id);
    if (!found || (found.scope !== undefined && !SCOPE.test(found.scope))) return undefined;
    const target: GitLabProjectTarget = {
      to: "gitlab-project",
      account: pinned,
      project: found.path,
    };
    if (found.host !== undefined) target.host = found.host;
    if (found.scope !== undefined) target.environment_scope = found.scope;
    return target;
  },
  describe: ({ project, host, environment_scope }) =>
    `${project}${at(host)}${environment_scope === undefined ? "" : ` (${environment_scope})`}`,
  named: ({ project, host }) => `the CI/CD variables of GitLab project ${project}${at(host)}`,
  where: ({ project, host, environment_scope }) =>
    `the GitLab project ${project}${at(host)}${environment_scope === undefined ? "" : ` (environment ${environment_scope})`}`,
  login: ({ host }, publisher) => loginOf(host, publisher),
  signInVariables: [TOKEN_VARIABLE],
  writeNote: NEXT_PIPELINE,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  refuses: refusedName,
  connect: ({ project, host, environment_scope }, publisher) => {
    const login = signIn(host, publisher);
    return new GitLabVariablesDestination({
      owner: "project",
      host: host ?? DEFAULT_HOST,
      path: project,
      environmentScope: environment_scope ?? "*",
      via: login.via,
      token: () => login.token(),
    });
  },
};

export const gitlabGroup: DestinationKind<GitLabGroupTarget, GitLabPublisher, GitLabHost> = {
  kind: "gitlab-group",
  label: "GitLab",
  parse(read) {
    const { path, account, host } = readPlace(read, "group", []);
    if (path === undefined || account === undefined) return undefined;
    const target: GitLabGroupTarget = { to: "gitlab-group", account, group: path };
    if (host !== undefined) target.host = host;
    return target;
  },
  id: ({ group, host }) => placeOf(group, host),
  secretId: ({ group, host }, secretName) => `${folded(group, host)}:${secretName}`,
  checkId: ({ group, host }) => folded(group, host),
  fromId(id, pinned) {
    const found = parseId(id);
    if (!found || found.scope !== undefined) return undefined;
    const target: GitLabGroupTarget = { to: "gitlab-group", account: pinned, group: found.path };
    if (found.host !== undefined) target.host = found.host;
    return target;
  },
  describe: ({ group, host }) => `group ${group}${at(host)}`,
  named: ({ group, host }) => `the CI/CD variables of GitLab group ${group}${at(host)}`,
  where: ({ group, host }) => `the GitLab group ${group}${at(host)}`,
  login: ({ host }, publisher) => loginOf(host, publisher),
  signInVariables: [TOKEN_VARIABLE],
  writeNote: NEXT_PIPELINE,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  refuses: refusedName,
  connect: ({ group, host }, publisher) => {
    const login = signIn(host, publisher);
    return new GitLabVariablesDestination({
      owner: "group",
      host: host ?? DEFAULT_HOST,
      path: group,
      environmentScope: "*",
      via: login.via,
      token: () => login.token(),
    });
  },
};

function loginOf(host: string | undefined, { signInEnv }: GitLabPublisher): string {
  return signInEnv[TOKEN_VARIABLE] === undefined
    ? `the glab login for ${host ?? DEFAULT_HOST}`
    : `the token in ${TOKEN_VARIABLE}`;
}

function refusedName(name: string): string | undefined {
  return NAME.test(name) ? undefined : "GitLab variable names use only letters, digits and _";
}
