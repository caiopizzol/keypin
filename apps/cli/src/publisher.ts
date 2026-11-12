import type { PublishTarget } from "@keypin/core";
import type { Deps, Publisher } from "./deps";

export async function publisherFor(
  targets: readonly PublishTarget[],
  deps: Deps,
  folder = deps.cwd,
): Promise<Publisher> {
  if (!targets.some((target) => target.to === "github-actions")) return { githubLogin: null };
  return { githubLogin: await githubLogin(deps, folder) };
}

export async function githubLogin(deps: Deps, folder: string): Promise<string | null> {
  return (await deps.git(folder, ["config", "--get", "github.account"]))?.trim() || null;
}

export function describeLogin(login: string | null): string {
  return login === null ? "the active gh login" : `${login} (git config github.account)`;
}
