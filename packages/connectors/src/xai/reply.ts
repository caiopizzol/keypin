import type { IssuerCheck } from "@keypin/core";
import { MANAGEMENT_KEYS } from "./api";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export function refused(reply: Reply, team: string): IssuerCheck {
  const facts = `xAI answered HTTP ${reply.status}`;
  const fix = `use a management key from team ${team} that can list, create and delete API keys; create one at ${MANAGEMENT_KEYS}`;
  if (reply.status === 400 || reply.status === 401)
    return { ok: false, facts, reason: "xAI doesn't accept the management key", fix };
  if (reply.status === 403)
    return {
      ok: false,
      facts,
      reason: `the management key can't list the API keys of team ${team}: it's for another team or organization, or lacks that permission`,
      fix,
    };
  if (reply.status === 404)
    return {
      ok: false,
      facts,
      reason: `the management key's organization has no team ${team}`,
      fix,
    };
  throw failure("GET", "/auth/teams/<team_id>/api-keys", reply);
}

export function failure(
  method: string,
  path: string,
  reply: Reply,
  type: new (message: string) => Error = Error,
): Error {
  return new type(`xAI ${method} ${path} returned HTTP ${reply.status}`);
}
