import { type DestinationKind, type Prerequisite } from "@keypin/core";
import { GitLabVariablesDestination, NEXT_PIPELINE } from "./gitlab";
import {
  at,
  DEFAULT_HOST,
  type GitLabGroupTarget,
  gitlabGroupRules,
  type GitLabProjectTarget,
  gitlabProjectRules,
} from "./rules";
import { findGlab, gitlabSignIn, TOKEN_VARIABLE, tokensPage } from "./token";

type Env = Readonly<Record<string, string | undefined>>;

export interface GitLabPublisher {
  signInEnv: Env;
  signInVariables: readonly string[];
}

export interface GitLabHost {
  readonly env: Env;
}

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

function signIn(host: string | undefined, { signInEnv, signInVariables }: GitLabPublisher) {
  return gitlabSignIn({ env: signInEnv, signIn: signInVariables, host: host ?? DEFAULT_HOST });
}

export const gitlabProject: DestinationKind<GitLabProjectTarget, GitLabPublisher, GitLabHost> = {
  ...gitlabProjectRules,
  where: ({ project, host, environment_scope }) =>
    `the GitLab project ${project}${at(host)}${environment_scope === undefined ? "" : ` (environment ${environment_scope})`}`,
  login: ({ host }, publisher) => loginOf(host, publisher),
  signInVariables: [TOKEN_VARIABLE],
  writeNote: NEXT_PIPELINE,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
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
  ...gitlabGroupRules,
  where: ({ group, host }) => `the GitLab group ${group}${at(host)}`,
  login: ({ host }, publisher) => loginOf(host, publisher),
  signInVariables: [TOKEN_VARIABLE],
  writeNote: NEXT_PIPELINE,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
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
