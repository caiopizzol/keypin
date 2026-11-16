import { type Fetch, isRecord } from "@keypin/core";

export interface FakeResend {
  admin?: string;
  known?: Record<string, string>;
  domains?: Record<string, string>;
  tokenPrefix: string;
  failCreate?: number;
  loseCreated?: boolean;
  keys: {
    load(): ResendKeys;
    save(keys: ResendKeys): void;
  };
  effect(line: string): void;
}

export interface ResendKeys {
  live: string[];
  created: number;
  names?: Record<string, string>;
}

export function resendFetch(fake: FakeResend): Fetch {
  return async (url, init) => {
    const { live: keys, created, names = {} } = fake.keys.load();
    const path = new URL(url).pathname;
    const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });
    const auth = init.headers.Authorization ?? "";
    const token = auth.replace(/^Bearer /, "");
    if (fake.admin !== undefined && token !== fake.admin) {
      const id = fake.known?.[token] ?? issuedId(fake.tokenPrefix, token);
      if (id === null || !keys.includes(id))
        return reply(400, { name: "validation_error", message: "API key is invalid" });
      return reply(401, {
        name: "restricted_api_key",
        message: "This API key is restricted to only send emails",
      });
    }
    if (init.method === "GET" && path.startsWith("/domains/")) {
      const id = decodeURIComponent(path.slice("/domains/".length));
      const name = fake.domains?.[id];
      if (name === undefined) return reply(404, { name: "not_found", message: "Domain not found" });
      return reply(200, { object: "domain", id, name, status: "verified" });
    }
    if (init.method === "GET" && path === "/api-keys")
      return reply(200, {
        object: "list",
        has_more: false,
        data: keys.map((id) => ({
          id,
          name: names[id] ?? id,
          created_at: "2026-11-01 17:09:51.813959+00",
        })),
      });
    if (init.method === "POST" && path === "/api-keys") {
      if (fake.failCreate !== undefined)
        return reply(fake.failCreate, {
          name: "internal_server_error",
          message: `refused ${auth}`,
        });
      const id = `re-new-${created + 1}`;
      const asked: unknown = JSON.parse(init.body ?? "{}");
      const domain =
        isRecord(asked) && typeof asked.domain_id === "string" ? asked.domain_id : null;
      const name = isRecord(asked) && typeof asked.name === "string" ? asked.name : id;
      fake.keys.save({
        live: [...keys, id],
        created: created + 1,
        names: { ...names, [id]: name },
      });
      fake.effect(`resend create ${id}${domain === null ? "" : ` for domain ${domain}`}`);
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(201, {
        id,
        object: "api_key",
        token: `${fake.tokenPrefix}${created + 1}${TOKEN_END}`,
      });
    }
    const id = decodeURIComponent(path.replace(/^\/api-keys\//, ""));
    if (init.method === "DELETE" && keys.includes(id)) {
      fake.keys.save({ live: keys.filter((k) => k !== id), created, names });
      fake.effect(`resend revoke ${id}`);
      return reply(200, { object: "api_key", id, deleted: true });
    }
    return reply(404, { name: "not_found" });
  };
}

const TOKEN_END = "_7d1b";

function issuedId(prefix: string, token: string): string | null {
  if (!token.startsWith(prefix) || !token.endsWith(TOKEN_END)) return null;
  return `re-new-${token.slice(prefix.length, -TOKEN_END.length)}`;
}

export function memoryKeys(initial: string[] = []) {
  let keys: ResendKeys = { live: [...initial], created: 0 };
  return { load: () => keys, save: (next: ResendKeys) => void (keys = next) };
}
