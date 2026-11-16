import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { workflowDiscovery, type WorkflowHost } from "./discovery";
import { GitHubSecretDestination } from "./github";
import { envTokens, tokenOnly } from "./token";

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

export interface GitHubHost extends WorkflowHost {
  readonly env: Readonly<Record<string, string | undefined>>;
  ghLogin(login: string | null): Promise<"ok" | "not installed" | "not logged in">;
}

async function configuredLogin(host: GitHubHost, folder: string): Promise<string | null> {
  return (await host.git(folder, ["config", "--get", "github.account"]))?.trim() || null;
}

const SIGN_IN = "gh auth login --hostname github.com";

async function ghPrerequisites(host: GitHubHost, folder: string): Promise<Prerequisite[]> {
  const login = await configuredLogin(host, folder);
  const status = await host.ghLogin(login);
  const signIn = `${SIGN_IN}${login ? `, signing in as ${login}` : ""}`;
  const body = [`  ${SIGN_IN}`, ...(login ? [`Sign in as ${login}.`] : [])];
  const step = { name: "GitHub", coversFailures: true };
  if (status === "not installed")
    return [
      {
        ...step,
        status,
        fix: `install gh (https://cli.github.com), then run ${signIn}`,
        title: "Install gh and sign in to GitHub",
        body: ["Install gh from https://cli.github.com, then run:", ...body],
      },
    ];
  if (status === "not logged in") {
    const tokens = envTokens(host.env);
    if (tokens.length) {
      const { why, command } = tokenOnly(tokens);
      const withToken = `${SIGN_IN} --with-token < token.txt`;
      return [
        {
          ...step,
          status,
          fix: `${why}; ${command}`,
          title: "Sign in to GitHub",
          body: [
            `${sentence(why)} Unset ${tokens.join(" ")}, then run:`,
            `  ${withToken}`,
            `Use a classic token with the repo scope${login ? `, for ${login}` : ""}.`,
          ],
        },
      ];
    }
    return [{ ...step, status, fix: `run ${signIn}`, title: "Sign in to GitHub", body }];
  }
  return [];
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

export const githubActions: DestinationKind<GitHubTarget, GitHubPublisher, GitHubHost> = {
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
  publisher: async (host, folder) => ({
    fields: { githubLogin: await configuredLogin(host, folder) },
  }),
  discovery: workflowDiscovery,
  prerequisites: async ({ folder, targets, used }, host) =>
    used || targets.length ? ghPrerequisites(host, folder) : [],
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
