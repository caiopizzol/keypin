import { isRecord, type Secret } from "@keypin/core";

export interface Listed {
  hash: string;
  name: string;
  label: string;
  disabled: boolean;
  limit: number | null;
  limitReset: string | null;
  includeByok: boolean;
  limitRemaining: number | null;
  createdAt: string | null;
  expiresAt: string | null;
  workspaceId: string | null;
  creatorUserId: string | null;
}

export interface VaultKey {
  label: string;
  management: boolean;
  organizationId: string | null;
  workspaceId: string | null;
  keyBudget: boolean;
}

export function listed(item: unknown): Listed | null {
  if (!isRecord(item) || typeof item.hash !== "string" || !item.hash) return null;
  const amount = (field: string) => {
    const value = item[field];
    return typeof value === "number" ? value : null;
  };
  return {
    hash: item.hash,
    name: text(item, "name") ?? "",
    label: text(item, "label") ?? "",
    disabled: item.disabled === true,
    limit: amount("limit"),
    limitReset: text(item, "limit_reset"),
    includeByok: item.include_byok_in_limit === true,
    limitRemaining: amount("limit_remaining"),
    createdAt: text(item, "created_at"),
    expiresAt: text(item, "expires_at"),
    workspaceId: text(item, "workspace_id"),
    creatorUserId: text(item, "creator_user_id"),
  };
}

export function text(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value ? value : null;
}

export function shownAs(label: string, current: Secret): boolean {
  const shown = /^(.+?)\.{3}(.+)$/.exec(label);
  if (!shown) return false;
  const [, start = "", end = ""] = shown;
  const value = current.reveal();
  return value.length > start.length + end.length && value.startsWith(start) && value.endsWith(end);
}
