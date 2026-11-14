import { type Fetch, isRecord } from "@keypin/core";

export interface FakeResend {
  admin?: string;
  tokenPrefix: string;
  failCreate?: boolean;
  keys: {
    load(): string[];
    save(ids: string[]): void;
  };
  effect(line: string): void;
}

export function resendFetch(fake: FakeResend): Fetch {
  return async (url, init) => {
    const keys = fake.keys.load();
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
      const id = `re-new-${keys.length}`;
      const asked: unknown = JSON.parse(init.body ?? "{}");
      const domain =
        isRecord(asked) && typeof asked.domain_id === "string" ? asked.domain_id : null;
      fake.keys.save([...keys, id]);
      fake.effect(`resend create ${id}${domain === null ? "" : ` for domain ${domain}`}`);
      return reply(201, {
        id,
        object: "api_key",
        token: `${fake.tokenPrefix}${keys.length}_7d1b`,
      });
    }
    const id = decodeURIComponent(path.replace(/^\/api-keys\//, ""));
    if (init.method === "DELETE" && keys.includes(id)) {
      fake.keys.save(keys.filter((k) => k !== id));
      fake.effect(`resend revoke ${id}`);
      return reply(200, { object: "api_key", id, deleted: true });
    }
    return reply(404, { name: "not_found" });
  };
}

export function memoryKeys(initial: string[] = []) {
  let ids = [...initial];
  return { load: () => ids, save: (next: string[]) => void (ids = next) };
}
