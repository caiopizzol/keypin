import type { DestinationRules, PullKind, TableReader } from "@keypin/core";

export type GitHubTarget = {
  to: "github-actions";
  repo: string;
  account: string;
  environment?: string;
};

export type GitHubPull = {
  by: "github-actions";
  repo: string;
  environment?: string;
};

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const PLACE = /^([^/]+\/[^/]+)(?:\/environments\/(.+))?$/;

function place(repo: string, environment: string | undefined): string {
  return environment === undefined ? repo : `${repo}/environments/${environment}`;
}

function folded({ repo, environment }: { repo: string; environment?: string }): string {
  return place(repo.toLowerCase(), environment?.toLowerCase());
}

function describe({ repo, environment }: { repo: string; environment?: string }): string {
  return environment === undefined ? repo : `${repo} environment ${environment}`;
}

function readPlace(read: TableReader): { repo: string; environment?: string } | undefined {
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
  return environment === undefined ? { repo } : { repo, environment };
}

export const githubPull: PullKind<GitHubPull> = {
  kind: "github-actions",
  label: "GitHub Actions",
  destination: "github-actions",
  parse(read) {
    read.only(["repo", "environment"]);
    const found = readPlace(read);
    return found && { by: "github-actions", ...found };
  },
  id: folded,
  describe,
};

export const githubActionsRules: DestinationRules<GitHubTarget> = {
  kind: "github-actions",
  label: "GitHub",
  parse(read) {
    read.only(["repo", "environment"], {
      account: `field "account" is from keypin 0.6; the map pins only repo = "owner/name", and each machine publishes as its own GitHub login (git config github.account, else the active gh login). Delete it (see docs/configuration.md for the current format)`,
    });
    const found = readPlace(read);
    if (found === undefined) return undefined;
    const { repo, environment } = found;
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
  refuses: (secretName) =>
    /^GITHUB_/i.test(secretName)
      ? "GitHub reserves secret names that start with GITHUB_"
      : undefined,
};
