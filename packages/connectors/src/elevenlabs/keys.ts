import { isRecord, objectField } from "@keypin/core";

export interface Listed {
  account: string;
  accountName: string;
  keyId: string;
  name: string;
  disabled: boolean;
  disableReason: string | null;
  permissions: string[] | null;
  characterLimit: number | null;
  allowedIps: string[] | null;
  thirdPartyDisable: boolean | null;
  limits: Record<string, unknown>;
  createdAt: number | null;
  expiresAt: number | null;
}

export function listedKeys(body: Record<string, unknown>): Listed[] {
  const accounts = Array.isArray(body["service-accounts"]) ? body["service-accounts"] : [];
  return accounts.filter(isRecord).flatMap((account) => {
    const id = text(account, "service_account_user_id");
    if (id === null) return [];
    const accountName = text(account, "name") ?? id;
    const keys = Array.isArray(account["api-keys"]) ? account["api-keys"] : [];
    return keys.filter(isRecord).flatMap((key) => {
      const keyId = text(key, "key_id");
      if (keyId === null) return [];
      return [
        {
          account: text(key, "service_account_user_id") ?? id,
          accountName,
          keyId,
          name: text(key, "name") ?? "",
          disabled: key.is_disabled === true,
          disableReason: text(key, "disable_reason"),
          permissions: strings(key.permissions),
          characterLimit: number(key.character_limit),
          allowedIps: strings(key.allowed_ips)?.length ? strings(key.allowed_ips) : null,
          thirdPartyDisable:
            typeof key.third_party_disable_allowed === "boolean"
              ? key.third_party_disable_allowed
              : null,
          limits: objectField(key, "platform_limits"),
          createdAt: number(key.created_at_unix),
          expiresAt: number(key.expires_at_unix),
        },
      ];
    });
  });
}

export function idOf(key: Listed): string {
  return `${key.account}/${key.keyId}`;
}

export function parseId(id: string): { account: string; keyId: string } | null {
  const parsed = /^([^/]+)\/([^/]+)$/.exec(id);
  return parsed?.[1] && parsed[2] ? { account: parsed[1], keyId: parsed[2] } : null;
}

export function numberIn(limit: Record<string, unknown>): number | null {
  return number(limit.limit);
}

function number(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function text(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value ? value : null;
}
