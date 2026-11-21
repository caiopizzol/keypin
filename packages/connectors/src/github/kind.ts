import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { workflowDiscovery, type WorkflowHost } from "./discovery";
import { GitHubSecretDestination } from "./github";
import { githubActionsRules, type GitHubTarget } from "./rules";
import { envTokens, ghToken, tokenOnly } from "./token";

export interface GitHubPublisher {
  githubLogin: string | null;
  refreshLogins: boolean;
  signInVariables: readonly string[];
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
            `Use a classic token with the repo, read:org and gist scopes (gh needs all three)${login ? `, for ${login}` : ""}.`,
          ],
        },
      ];
    }
    return [{ ...step, status, fix: `run ${signIn}`, title: "Sign in to GitHub", body }];
  }
  return [];
}

export const githubActions: DestinationKind<GitHubTarget, GitHubPublisher, GitHubHost> = {
  ...githubActionsRules,
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
  connect: ({ repo, environment }, publisher) =>
    new GitHubSecretDestination({
      repo,
      ...(environment === undefined ? {} : { environment }),
      login: publisher.githubLogin,
      token: () =>
        ghToken(publisher.githubLogin, {
          refresh: publisher.refreshLogins,
          signIn: publisher.signInVariables,
        }),
    }),
};
