import { isRecord } from "@keypin/core";

export interface Listed {
  id: string;
  name: string;
  disabled: boolean;
  acls: string[];
  qps: number | null;
  qpm: number | null;
  tpm: string | null;
  createTime: string | null;
  expireTime: string | null;
}

export interface VaultKey {
  id: string;
  team: string;
  off: string | null;
}

export const idOf = (team: string, key: string) => `${team}/${key}`;

export function parseId(id: string): { team: string; key: string } | null {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1 || id.indexOf("/", at + 1) !== -1) return null;
  return { team: id.slice(0, at), key: id.slice(at + 1) };
}

export function listed(item: unknown): Listed[] {
  if (!isRecord(item)) return [];
  const id = text(item, "apiKeyId");
  if (!id) return [];
  const acls = item.aclStrings ?? item.acl_strings;
  return [
    {
      id,
      name: text(item, "name") ?? "",
      disabled: item.disabled === true || item.disabled === "true",
      acls: Array.isArray(acls) ? acls.filter((acl): acl is string => typeof acl === "string") : [],
      qps: count(item.qps),
      qpm: count(item.qpm),
      tpm: count(item.tpm) === null ? null : String(count(item.tpm)),
      createTime: text(item, "createTime"),
      expireTime: text(item, "expireTime"),
    },
  ];
}

function count(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

export function text(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value ? value : null;
}
