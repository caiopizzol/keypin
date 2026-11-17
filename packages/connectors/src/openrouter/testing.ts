import { type Fetch, isRecord } from "@keypin/core";

export interface FakeOpenRouterKey {
  hash: string;
  name: string;
  value: string;
  disabled?: boolean;
  management?: boolean;
  limit?: number;
  limitReset?: "daily" | "weekly" | "monthly";
  includeByok?: boolean;
  usage?: number;
  lifetimeDays?: number;
  workspaceId?: string;
  creatorUserId?: string;
}

export interface OpenRouterWorld {
  keys: FakeOpenRouterKey[];
  created: number;
}

export interface FakeOpenRouter {
  admin: string;
  valuePrefix: string;
  organizationId?: string;
  workspaceId?: string;
  pageSize?: number;
  guardrailKeys?: readonly string[];
  byokKeys?: readonly string[];
  observability?: readonly { enabled: boolean; hashes: readonly string[] | null }[];
  failCreate?: number;
  loseCreated?: boolean;
  world: { load(): OpenRouterWorld; save(world: OpenRouterWorld): void };
  effect(line: string): void;
}

const CREATED_AT = "2026-01-01T00:00:00Z";
const DAY = 86_400_000;
const VALUE_END = "_9c4e";

export function label(value: string): string {
  return `${value.slice(0, 11)}...${value.slice(-3)}`;
}

export function openrouterFetch(fake: FakeOpenRouter): Fetch {
  return async (url, init) => {
    const { keys, created } = fake.world.load();
    const { pathname, searchParams } = new URL(url);
    const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });
    const error = (status: number, message: string) =>
      reply(status, {
        error: { code: status, message: `${message} ${init.headers.Authorization}` },
      });
    const token = (init.headers.Authorization ?? "").replace(/^Bearer /, "");
    const workspace = fake.workspaceId ?? "ws_default";

    if (pathname === "/api/v1/key" && init.method === "GET") {
      const key = keys.find((k) => k.value === token);
      if (token === fake.admin)
        return reply(200, {
          data: { ...current(fake.admin, workspace, fake), is_management_key: true },
        });
      if (!key || key.disabled) return error(401, "User not found.");
      return reply(200, {
        data: {
          ...current(key.value, key.workspaceId ?? workspace, fake),
          is_management_key: key.management === true,
          limit: key.limit ?? null,
          limit_reset: key.limitReset ?? null,
          budgets: fake.guardrailKeys?.includes(key.hash)
            ? [{ scope: "api_key", limit_usd: 5 }]
            : [],
        },
      });
    }
    if (token !== fake.admin) return error(401, "Invalid management key");
    const ws = searchParams.get("workspace_id");
    if (ws !== null && ws !== workspace)
      return error(403, "Management key is scoped to a different workspace");
    const size = fake.pageSize ?? 100;
    const offset = Number(searchParams.get("offset") ?? 0);

    if (pathname === "/api/v1/keys" && init.method === "GET") {
      const shown = keys.filter(
        (k) => !k.management && (searchParams.get("include_disabled") === "true" || !k.disabled),
      );
      return reply(200, {
        data: shown.slice(offset, offset + size).map((k) => listed(k, workspace)),
      });
    }
    if (pathname === "/api/v1/guardrails/assignments/keys" && init.method === "GET") {
      const all = (fake.guardrailKeys ?? []).map((hash) => ({
        id: `ga_${hash}`,
        key_hash: hash,
        guardrail_id: "gr_1",
      }));
      return reply(200, { data: all.slice(offset, offset + size), total_count: all.length });
    }
    if (pathname === "/api/v1/byok" && init.method === "GET") {
      const all = (fake.byokKeys ?? []).map((hash) => ({
        id: `byok_${hash}`,
        provider: "openai",
        allowed_api_key_hashes: [hash],
      }));
      return reply(200, { data: all.slice(offset, offset + size), total_count: all.length });
    }
    if (pathname === "/api/v1/observability/destinations" && init.method === "GET") {
      const all = (fake.observability ?? []).map((destination, i) => ({
        id: `obs_${i + 1}`,
        type: "langfuse",
        enabled: destination.enabled,
        api_key_hashes: destination.hashes,
      }));
      return reply(200, { data: all.slice(offset, offset + size), total_count: all.length });
    }
    if (pathname === "/api/v1/keys" && init.method === "POST") {
      if (fake.failCreate !== undefined) return error(fake.failCreate, "Internal Server Error");
      const asked: unknown = JSON.parse(init.body ?? "{}");
      if (!isRecord(asked) || typeof asked.name !== "string") return error(400, "name is required");
      const hash = `hash_new${created + 1}`;
      const value = `${fake.valuePrefix}${created + 1}${VALUE_END}`;
      const expires = typeof asked.expires_at === "string" ? asked.expires_at : null;
      const key: FakeOpenRouterKey = {
        hash,
        name: asked.name,
        value,
        ...(typeof asked.limit === "number" ? { limit: asked.limit } : {}),
        ...(asked.limit_reset === "daily" ||
        asked.limit_reset === "weekly" ||
        asked.limit_reset === "monthly"
          ? { limitReset: asked.limit_reset }
          : {}),
        ...(asked.include_byok_in_limit === true ? { includeByok: true } : {}),
        ...(typeof asked.workspace_id === "string" ? { workspaceId: asked.workspace_id } : {}),
        ...(typeof asked.creator_user_id === "string"
          ? { creatorUserId: asked.creator_user_id }
          : {}),
      };
      fake.world.save({ keys: [...keys, key], created: created + 1 });
      const settings = [
        ...(key.limit === undefined
          ? []
          : [`limit $${key.limit}${key.limitReset ? ` ${key.limitReset}` : ""}`]),
        ...(key.includeByok ? ["byok"] : []),
        ...(expires === null ? [] : [`expires ${expires}`]),
        ...(key.workspaceId ? [`workspace ${key.workspaceId}`] : []),
        ...(key.creatorUserId ? [`for ${key.creatorUserId}`] : []),
      ];
      fake.effect(
        `openrouter create ${hash}${settings.length ? ` with ${settings.join(", ")}` : ""}`,
      );
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(201, { data: listed(key, workspace), key: value });
    }
    const one = /^\/api\/v1\/keys\/([^/]+)$/.exec(pathname);
    const hash = decodeURIComponent(one?.[1] ?? "");
    const found = keys.find((k) => k.hash === hash && !k.management);
    if (one && init.method === "GET" && found)
      return reply(200, { data: listed(found, workspace) });
    if (one && init.method === "DELETE" && found) {
      fake.world.save({ keys: keys.filter((k) => k.hash !== hash), created });
      fake.effect(`openrouter revoke ${hash}`);
      return reply(200, { deleted: true });
    }
    return error(404, "Not Found");
  };
}

function current(value: string, workspace: string, fake: FakeOpenRouter) {
  return {
    label: label(value),
    limit: null,
    usage: 0,
    is_free_tier: false,
    organization_id: fake.organizationId ?? null,
    workspace_id: workspace,
    budgets: [],
  };
}

function listed(key: FakeOpenRouterKey, workspace: string) {
  const usage = key.usage ?? 0;
  return {
    hash: key.hash,
    name: key.name,
    label: label(key.value),
    disabled: key.disabled === true,
    limit: key.limit ?? null,
    limit_remaining: key.limit === undefined ? null : key.limit - usage,
    limit_reset: key.limitReset ?? null,
    include_byok_in_limit: key.includeByok === true,
    usage,
    created_at: CREATED_AT,
    expires_at:
      key.lifetimeDays === undefined
        ? null
        : new Date(Date.parse(CREATED_AT) + key.lifetimeDays * DAY).toISOString(),
    workspace_id: key.workspaceId ?? workspace,
    creator_user_id: key.creatorUserId ?? null,
  };
}

export function memoryWorld(initial: FakeOpenRouterKey[] = []) {
  let world: OpenRouterWorld = { keys: [...initial], created: 0 };
  return { load: () => world, save: (next: OpenRouterWorld) => void (world = next) };
}
