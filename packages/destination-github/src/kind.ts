import type { DestinationKind } from "@keypin/core";
import { GitHubSecretDestination } from "./github";

export type GitHubTarget = {
  to: "github-actions";
  repo: string;
  account: string;
  environment?: string;
};

export interface GitHubPublisher {
  githubLogin: string | null;
  refreshLogins: boolean;
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const PLACE = /^([^/]+\/[^/]+)(?:\/environments\/(.+))?$/;

function place(repo: string, environment: string | undefined): string {
  return environment === undefined ? repo : `${repo}/environments/${environment}`;
}

function folded({ repo, environment }: GitHubTarget): string {
  return place(repo.toLowerCase(), environment?.toLowerCase());
}

function describe({ repo, environment }: GitHubTarget): string {
  return environment === undefined ? repo : `${repo} environment ${environment}`;
}

export const githubActions: DestinationKind<GitHubTarget, GitHubPublisher> = {
  kind: "github-actions",
  label: "GitHub",
  parse(read) {
    read.only(["repo", "environment"], {
      account: `field "account" is from keypin 0.6; the map pins only repo = "owner/name", and each machine publishes as its own GitHub login (git config github.account, else the active gh login). Delete it (see docs/configuration.md for the current format)`,
    });
    const repo = read.filledIn(
      read.required("repo"),
      "repo",
      `the GitHub repository as "owner/name", such as "acme/billing"`,
    );
    if (repo !== undefined && !REPO.test(repo)) read.fail(`field "repo" must be "owner/name"`);
    const environment = read.filledIn(
      read.optional("environment"),
      "environment",
      "the name of a GitHub environment of the repository, such as production",
    );
    if (environment !== undefined && (environment.length > 255 || /^\.\.?$/.test(environment)))
      read.fail(
        `field "environment" must be a GitHub environment name, at most 255 characters and not . or ..`,
      );
    if (repo === undefined) return undefined;
    const [account = ""] = repo.split("/");
    const target: GitHubTarget = { to: "github-actions", repo, account };
    return environment === undefined ? target : { ...target, environment };
  },
  id: ({ repo, environment }) => place(repo, environment),
  secretId: (target, secretName) => `${folded(target)}:${secretName.toUpperCase()}`,
  checkId: folded,
  fromId(id, pinned) {
    const [, repo, environment] = PLACE.exec(id) ?? [];
    if (repo === undefined) return undefined;
    const target: GitHubTarget = { to: "github-actions", repo, account: pinned };
    return environment === undefined ? target : { ...target, environment };
  },
  describe,
  named: (target) => `GitHub ${describe(target)}`,
  where: ({ repo, environment }) =>
    `${repo}${environment === undefined ? "" : ` (environment ${environment})`}`,
  login: (_target, { githubLogin }) =>
    githubLogin === null ? "the active gh login" : `${githubLogin} (git config github.account)`,
  refuses: (secretName) =>
    /^GITHUB_/i.test(secretName)
      ? "GitHub reserves secret names that start with GITHUB_"
      : undefined,
  connect: ({ repo, environment }, publisher) =>
    new GitHubSecretDestination({
      repo,
      ...(environment === undefined ? {} : { environment }),
      login: publisher.githubLogin,
      refresh: publisher.refreshLogins,
    }),
};
