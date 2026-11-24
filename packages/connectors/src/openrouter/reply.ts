import type { IssuerCheck } from "@keypin/core";

export const DASHBOARD = "https://openrouter.ai/settings/keys";
export const MANAGEMENT_KEYS = "https://openrouter.ai/settings/management-keys";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export function refused(reply: Reply, workspace: string | null, path: string): IssuerCheck {
  const facts = `OpenRouter answered HTTP ${reply.status}`;
  const fix = `put a read/write management key in the admin item; create one at ${MANAGEMENT_KEYS}`;
  if (reply.status === 401)
    return {
      ok: false,
      facts,
      reason:
        "OpenRouter doesn't accept the management key: it isn't a management key, it expired or was deleted, or the item holds another value",
      fix,
    };
  if (reply.status === 403)
    return {
      ok: false,
      facts,
      reason: `the management key can't list keys${workspace === null ? "" : ` in workspace ${workspace}, the vault key's workspace`}: it's scoped to another workspace`,
      fix: `${fix}, in that workspace or for the whole organization`,
    };
  if ((reply.status === 400 || reply.status === 404) && workspace !== null)
    return {
      ok: false,
      facts,
      reason: `the management key's account has no workspace ${workspace}, the vault key's workspace: the vault's key is from another account`,
      fix: `use a management key from the account that has the key at ${DASHBOARD}`,
    };
  throw new Error(`OpenRouter GET ${path} returned HTTP ${reply.status}`);
}
