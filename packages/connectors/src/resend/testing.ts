import { type Fetch, isRecord } from "@keypin/core";

export interface FakeResend {
  admin?: string;
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
    if (fake.admin !== undefined && auth !== `Bearer ${fake.admin}`)
      return reply(401, { name: "validation_error", message: "API key is invalid" });
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
        token: `${fake.tokenPrefix}${created + 1}_7d1b`,
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

export function memoryKeys(initial: string[] = []) {
  let keys: ResendKeys = { live: [...initial], created: 0 };
  return { load: () => keys, save: (next: ResendKeys) => void (keys = next) };
}
