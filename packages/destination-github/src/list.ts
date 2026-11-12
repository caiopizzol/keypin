import { isRecord, type StoreRead } from "@keypin/core";
import type { Fetch } from "./github";

const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export async function listRepoSecrets(options: {
  repo: string;
  token: () => Promise<string>;
  fetch?: Fetch;
}): Promise<StoreRead> {
  if (!REPO.test(options.repo))
    return {
      ok: false,
      reason: `"${options.repo}" isn't a GitHub repository in the form owner/name`,
    };
  const fetch = options.fetch ?? globalThis.fetch;
  let token: string;
  try {
    token = await options.token();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "no GitHub token" };
  }
  const secrets: { name: string; updatedAt: string | null }[] = [];
  for (let page = 1; ; page++) {
    const path = `/repos/${options.repo}/actions/secrets?per_page=100&page=${page}`;
    const response = await fetch(`${API}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ok: false, reason: refusal(response.status, options.repo) };
    }
    const body: unknown = await response.json().catch(() => null);
    const list = isRecord(body) && Array.isArray(body.secrets) ? body.secrets : null;
    if (!list) return { ok: false, reason: "GitHub's secrets response has no secrets list" };
    for (const secret of list) {
      if (!isRecord(secret) || typeof secret.name !== "string") continue;
      secrets.push({
        name: secret.name,
        updatedAt: typeof secret.updated_at === "string" ? secret.updated_at : null,
      });
    }
    const total = isRecord(body) && typeof body.total_count === "number" ? body.total_count : 0;
    if (list.length < 100 || secrets.length >= total) return { ok: true, secrets };
  }
}

function refusal(status: number, repo: string): string {
  if (status === 404) return `HTTP 404: the login can't see ${repo}, or isn't a collaborator on it`;
  if (status === 403) return `HTTP 403: the login isn't allowed to list ${repo}'s secrets`;
  if (status === 401) return "HTTP 401: the gh login's token was refused";
  return `GitHub returned HTTP ${status}`;
}
