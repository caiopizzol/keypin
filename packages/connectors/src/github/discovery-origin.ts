import { NOT_ENTERPRISE } from "./refusal";
import { isSshName } from "./ssh";
import type { WorkflowHost } from "./discovery-repo";

const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:([^@/:]+)@)?([^/:]+)(?::\d+)?\/|(?:([^@/:]+)@)?([^/:]+):)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_HOST = /^(?:ssh\.)?github\.com$/i;
const NOT_GITHUB = "the origin remote isn't on github.com";
const ENTERPRISE_HOST = /^(?!(?:ssh\.)?github\.com$).*(?:github|(?:^|\.)ghe\.com$)/i;

function notGitHub(host: string | undefined): { reason: string } {
  return {
    reason: host && ENTERPRISE_HOST.test(host) ? `${NOT_GITHUB}; ${NOT_ENTERPRISE}` : NOT_GITHUB,
  };
}

function hostOf(url: string): string | undefined {
  return /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1];
}

export async function githubOrigin(
  host: WorkflowHost,
  folder: string,
): Promise<{ repo: string } | { reason: string } | null> {
  const url = (await host.git(folder, ["remote", "get-url", "origin"]))?.trim();
  if (!url) return null;
  const [, sshUser, sshHost, scpUser, scpHost, owner, name] = GITHUB_REMOTE.exec(url) ?? [];
  if (!owner || !name) return notGitHub(hostOf(url));
  const alias = sshHost ?? scpHost;
  const user = sshUser ?? scpUser;
  if (alias !== undefined && !GITHUB_SSH_HOST.test(alias)) {
    if (!isSshName(alias) || (user !== undefined && !isSshName(user)))
      return {
        reason:
          "the origin remote's SSH host or user isn't a plain name, so check didn't ask ssh which server it is",
      };
    const real = await host
      .sshHostname(user === undefined ? alias : `${user}@${alias}`)
      .catch(() => null);
    if (real === null)
      return {
        reason: `ssh -G couldn't tell which server the origin remote's host ${alias} is, so check can't tell whether it's on github.com`,
      };
    if (!GITHUB_SSH_HOST.test(real)) return notGitHub(real);
  }
  return { repo: `${owner}/${name}` };
}
