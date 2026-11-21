import type { DestinationRules, TableReader } from "@keypin/core";

export const DEFAULT_HOST = "gitlab.com";
export const HOST =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;
export const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
export const NAME = /^[A-Za-z0-9_]{1,255}$/;

export type Owner = "project" | "group";

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

const SCOPE = /^[A-Za-z0-9 _./${}*-]{1,255}$/;
const ID = /^([^@#]+)(?:@([^@#]+))?(?:#(.+))?$/;

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

export const at = (host: string | undefined) => (host === undefined ? "" : ` on ${host}`);
const placeOf = (path: string, host?: string, scope?: string) =>
  `${path}${host === undefined ? "" : `@${host}`}${scope === undefined ? "" : `#${scope}`}`;
const folded = (path: string, host?: string) => `${host ?? DEFAULT_HOST}/${path.toLowerCase()}`;

function parseId(id: string) {
  const [, path, host, scope] = ID.exec(id) ?? [];
  return path !== undefined && PATH.test(path) ? { path, host, scope } : undefined;
}

function refusedName(name: string): string | undefined {
  return NAME.test(name) ? undefined : "GitLab variable names use only letters, digits and _";
}

export const gitlabProjectRules: DestinationRules<GitLabProjectTarget> = {
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
  refuses: refusedName,
};

export const gitlabGroupRules: DestinationRules<GitLabGroupTarget> = {
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
  refuses: refusedName,
};
