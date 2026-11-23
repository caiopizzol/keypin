import { isRecord, objectField, type Secret } from "@keypin/core";

export const DAY = 86_400_000;
const NAME_LIMIT = 120;

export interface Policy {
  effect: string;
  resources: Record<string, unknown>;
  permission_groups: { id: string }[];
}

export interface Token {
  id: string;
  name: string;
  status: string;
  policies: Policy[];
  permissions: string[];
  condition: Record<string, unknown> | null;
  notBefore: string | null;
  expiresOn: string | null;
  issuedOn: string | null;
}

export interface Copy {
  policies: Policy[];
  permissions: string[];
  condition: Record<string, unknown> | null;
  notBefore: string | null;
  lifetime: number | null;
}

export type TokenKind =
  | "Global API Key"
  | "wrangler login token"
  | "account API token"
  | "user API token";

export function tokenKind(current: Secret): TokenKind | null {
  if (current.reveal().startsWith("cfk_")) return "Global API Key";
  if (current.reveal().startsWith("cfoat_")) return "wrangler login token";
  if (current.reveal().startsWith("cfat_")) return "account API token";
  if (current.reveal().startsWith("cfut_")) return "user API token";
  return null;
}

export function parseToken(body: Record<string, unknown>, id: string): Token | null {
  const result = objectField(body, "result");
  if (!Array.isArray(result.policies) || !result.policies.length) return null;
  const policies = result.policies.map(parsePolicy);
  if (policies.some((policy) => policy === null)) return null;
  const permissions = result.policies.flatMap((policy: unknown) =>
    isRecord(policy) && Array.isArray(policy.permission_groups)
      ? policy.permission_groups.map((group: unknown) =>
          isRecord(group) && typeof group.name === "string" && group.name
            ? group.name
            : String(isRecord(group) ? group.id : group),
        )
      : [],
  );
  const text = (field: string) => {
    const value = result[field];
    return typeof value === "string" && value ? value : null;
  };
  const condition =
    isRecord(result.condition) && Object.keys(result.condition).length ? result.condition : null;
  return {
    id: text("id") ?? id,
    name: text("name") ?? "",
    status: text("status") ?? "active",
    policies: policies.filter((policy) => policy !== null),
    permissions: [...new Set(permissions)],
    condition,
    notBefore: text("not_before"),
    expiresOn: text("expires_on"),
    issuedOn: text("issued_on"),
  };
}

export function parsePolicy(item: unknown): Policy | null {
  if (!isRecord(item) || typeof item.effect !== "string" || !isRecord(item.resources)) return null;
  if (!Array.isArray(item.permission_groups) || !item.permission_groups.length) return null;
  const groups = item.permission_groups.map((group: unknown) =>
    isRecord(group) && typeof group.id === "string" && group.id ? { id: group.id } : null,
  );
  if (groups.some((group) => group === null)) return null;
  return {
    effect: item.effect,
    resources: item.resources,
    permission_groups: groups.filter((group) => group !== null),
  };
}

export function copies(copy: Copy): string {
  const kept = [
    `the old token's ${plural(copy.policies.length, "policy", "policies")} (${copy.permissions.join(", ")})`,
    ...(copy.condition === null ? [] : ["IP filter"]),
    ...(copy.notBefore === null ? [] : [`start date ${copy.notBefore.slice(0, 10)}`]),
  ];
  const list = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
  const expires =
    copy.lifetime === null
      ? "no expiry"
      : `expiring ${plural(Math.ceil(copy.lifetime / DAY), "day", "days")} after it starts`;
  return `with ${list}; ${expires}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function fitName(name: string): string {
  return name.length <= NAME_LIMIT ? name : `…${name.slice(name.length - NAME_LIMIT + 1)}`;
}
