import type { Json, ProviderToken, TokenPolicy } from "./contracts";
import { isRecord } from "./record";

export function sameAccess(a: ProviderToken, b: ProviderToken): boolean {
  return (
    canonical(a.policies.map(policyShape)) === canonical(b.policies.map(policyShape)) &&
    canonical(a.condition ?? {}) === canonical(b.condition ?? {})
  );
}

function policyShape(policy: TokenPolicy): Json {
  return {
    effect: policy.effect,
    resources: policy.resources,
    groups: policy.permissionGroups.map((group) => group.id),
  };
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).toSorted().join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item ?? null)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
