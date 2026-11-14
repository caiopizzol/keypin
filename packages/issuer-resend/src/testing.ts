import { type Fetch, isRecord } from "@keypin/core";

export interface FakeResend {
  admin?: string;
  tokenPrefix: string;
  failCreate?: boolean;
  keys: {
    load(): ResendKeys;
    save(keys: ResendKeys): void;
  };
  effect(line: string): void;
}

export interface ResendKeys {
  live: string[];
  created: number;
}

export function resendFetch(fake: FakeResend): Fetch {
  return async (url, init) => {
    const { live: keys, created } = fake.keys.load();
    const path = new URL(url).pathname;
    const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });
    const auth = init.headers.Authorization ?? "";
    if (fake.admin !== undefined && auth !== `Bearer ${fake.admin}`)
      return reply(401, { name: "validation_error", message: "API key is invalid" });
    if (init.method === "GET" && path === "/api-keys")
      return reply(200, { object: "list", has_more: false, data: keys.map((id) => ({ id })) });
    if (init.method === "POST" && path === "/api-keys") {
      if (fake.failCreate)
        return reply(500, { name: "internal_server_error", message: `refused ${auth}` });
      const id = `re-new-${created + 1}`;
      const asked: unknown = JSON.parse(init.body ?? "{}");
      const domain =
        isRecord(asked) && typeof asked.domain_id === "string" ? asked.domain_id : null;
      fake.keys.save({ live: [...keys, id], created: created + 1 });
      fake.effect(`resend create ${id}${domain === null ? "" : ` for domain ${domain}`}`);
      return reply(201, {
        id,
        object: "api_key",
        token: `${fake.tokenPrefix}${created + 1}_7d1b`,
      });
    }
    const id = decodeURIComponent(path.replace(/^\/api-keys\//, ""));
    if (init.method === "DELETE" && keys.includes(id)) {
      fake.keys.save({ live: keys.filter((k) => k !== id), created });
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
