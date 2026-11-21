import { type IssuerCheck, objectField } from "@keypin/core";

export const ADMIN_FIX =
  "put a workspace admin's API key in the admin item; a restricted key needs access to service accounts";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export function refusedAdmin(reply: Reply): IssuerCheck {
  const facts = `ElevenLabs answered HTTP ${reply.status}`;
  if (reply.status === 401 && !missingPermission(reply))
    return {
      ok: false,
      facts,
      reason:
        "ElevenLabs doesn't accept the admin key: it was deleted, disabled or expired, or the item holds another value",
      fix: ADMIN_FIX,
    };
  if (reply.status === 403 && !missingPermission(reply))
    return {
      ok: false,
      facts,
      reason:
        "ElevenLabs refused the admin key from this machine: its IP allowlist may not include this address, or it can't list service accounts",
      fix: `run this from an address the admin key allows, or check its IP allowlist; ${ADMIN_FIX}`,
    };
  if (reply.status === 401 || reply.status === 403)
    return {
      ok: false,
      facts,
      reason:
        "the admin key can't list service accounts: only a workspace admin's key with access to service accounts can",
      fix: ADMIN_FIX,
    };
  throw new Error(returned("GET", "/v1/service-accounts", reply));
}

export function missingPermission(reply: Reply): boolean {
  const detail = objectField(reply.body, "detail");
  return detail.code === "missing_permissions" || detail.status === "missing_permissions";
}

export function returned(method: string, path: string, reply: Reply): string {
  const code = objectField(reply.body, "detail").code;
  return `ElevenLabs ${method} ${path} returned HTTP ${reply.status}${typeof code === "string" && code ? ` ${code}` : ""}`;
}
