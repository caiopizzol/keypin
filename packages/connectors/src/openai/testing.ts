import { type Fetch, isRecord } from "@keypin/core";

export interface FakeOpenAIKey {
  id: string;
  name: string;
  value: string;
  owner: { type: "user" | "service_account"; id: string; name: string };
  scopes?: readonly string[];
  lifetime?: number;
}

export interface OpenAIKeys {
  live: FakeOpenAIKey[];
  created: number;
}

export interface FakeOpenAI {
  admin: string;
  projectId: string;
  projectName?: string;
  tokenPrefix: string;
  pageSize?: number;
  failCreate?: number;
  loseCreated?: boolean;
  serviceAccounts?: readonly FakeOpenAIKey["owner"][];
  keys: {
    load(): OpenAIKeys;
    save(keys: OpenAIKeys): void;
  };
  effect(line: string): void;
}

const CREATED_AT = 1_763_000_000;

export function redacted(value: string): string {
  const start = /^sk-(?:[a-z]+-)?/.exec(value)?.[0] ?? "sk-";
  return `${start}${"*".repeat(Math.max(value.length - start.length - 4, 1))}${value.slice(-4)}`;
}

export function openaiFetch(fake: FakeOpenAI): Fetch {
  return async (url, init) => {
    const { live, created } = fake.keys.load();
    const { pathname, searchParams } = new URL(url);
    const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });
    const error = (status: number, code: string) =>
      reply(status, { error: { message: `refused ${init.headers.Authorization}`, code } });
    const token = (init.headers.Authorization ?? "").replace(/^Bearer /, "");

    if (pathname === "/v1/models" && init.method === "GET") {
      if (!live.some((key) => key.value === token)) return error(401, "invalid_api_key");
      return reply(200, { object: "list", data: [] });
    }
    if (token !== fake.admin) return error(401, "invalid_api_key");
    const project = `/v1/organization/projects/${fake.projectId}`;
    if (!pathname.startsWith(project)) return error(404, "not_found");
    const rest = pathname.slice(project.length);

    if (init.method === "GET" && rest === "")
      return reply(200, {
        object: "organization.project",
        id: fake.projectId,
        name: fake.projectName ?? fake.projectId,
        status: "active",
      });
    if (init.method === "GET" && rest === "/api_keys") {
      const size = Math.min(Number(searchParams.get("limit") ?? 20), fake.pageSize ?? 100);
      const after = searchParams.get("after");
      const from = after === null ? 0 : live.findIndex((key) => key.id === after) + 1;
      const page = live.slice(from, from + size);
      return reply(200, {
        object: "list",
        data: page.map(listed),
        first_id: page[0]?.id ?? null,
        last_id: page.at(-1)?.id ?? null,
        has_more: from + size < live.length,
      });
    }
    const make = /^\/service_accounts\/([^/]+)\/api_keys$/.exec(rest);
    if (init.method === "POST" && make) {
      const account = decodeURIComponent(make[1] ?? "");
      const owner =
        live.find((key) => key.owner.type === "service_account" && key.owner.id === account)
          ?.owner ?? fake.serviceAccounts?.find((known) => known.id === account);
      if (!owner) return error(404, "not_found");
      if (fake.failCreate !== undefined) return error(fake.failCreate, "server_error");
      const asked: unknown = JSON.parse(init.body ?? "{}");
      const id = `key_new${created + 1}`;
      const value = `${fake.tokenPrefix}${created + 1}${TOKEN_END}`;
      const scopes =
        isRecord(asked) && Array.isArray(asked.scopes)
          ? asked.scopes.filter((scope): scope is string => typeof scope === "string")
          : [];
      const lifetime =
        isRecord(asked) && typeof asked.expires_in_seconds === "number"
          ? asked.expires_in_seconds
          : undefined;
      const name = isRecord(asked) && typeof asked.name === "string" ? asked.name : id;
      fake.keys.save({
        live: [
          ...live,
          {
            id,
            name,
            value,
            owner,
            ...(scopes.length ? { scopes } : {}),
            ...(lifetime === undefined ? {} : { lifetime }),
          },
        ],
        created: created + 1,
      });
      const limits = [
        ...(scopes.length ? [`scopes ${scopes.join(" ")}`] : []),
        ...(lifetime === undefined ? [] : [`expiring in ${lifetime}s`]),
      ];
      fake.effect(
        `openai create ${id} for ${account}${limits.length ? ` with ${limits.join(", ")}` : ""}`,
      );
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(200, {
        object: "organization.project.service_account.api_key",
        id,
        name,
        value,
        created_at: CREATED_AT,
        expires_at: lifetime === undefined ? null : CREATED_AT + lifetime,
      });
    }
    const one = /^\/api_keys\/([^/]+)$/.exec(rest);
    const id = decodeURIComponent(one?.[1] ?? "");
    if (init.method === "DELETE" && one && live.some((key) => key.id === id)) {
      fake.keys.save({ live: live.filter((key) => key.id !== id), created });
      fake.effect(`openai revoke ${id}`);
      return reply(200, { object: "organization.project.api_key.deleted", id, deleted: true });
    }
    return error(404, "not_found");
  };
}

const TOKEN_END = "_9c4e";

function listed(key: FakeOpenAIKey) {
  const owner =
    key.owner.type === "user"
      ? { type: "user", user: { id: key.owner.id, name: key.owner.name, role: "owner" } }
      : {
          type: "service_account",
          service_account: { id: key.owner.id, name: key.owner.name, role: "member" },
        };
  return {
    object: "organization.project.api_key",
    id: key.id,
    name: key.name,
    redacted_value: redacted(key.value),
    created_at: CREATED_AT,
    last_used_at: null,
    owner,
    owner_project_access: "active",
    expires_at: key.lifetime === undefined ? null : CREATED_AT + key.lifetime,
  };
}

export function memoryKeys(initial: FakeOpenAIKey[] = []) {
  let keys: OpenAIKeys = { live: [...initial], created: 0 };
  return { load: () => keys, save: (next: OpenAIKeys) => void (keys = next) };
}
