import { type Fetch, isRecord } from "@keypin/core";

export interface SupabaseKey {
  id: string;
  name: string;
  type: "secret" | "publishable" | "legacy";
  value: string;
  template?: Record<string, unknown>;
}

export interface SupabaseWorld {
  keys: SupabaseKey[];
  created: number;
}

export interface FakeSupabase {
  admin?: string;
  projectRef: string;
  valuePrefix: string;
  failList?: number;
  failCreate?: number;
  loseCreated?: boolean;
  hideValues?: boolean;
  prefixOnly?: boolean;
  world: {
    load(): SupabaseWorld;
    save(world: SupabaseWorld): void;
  };
  effect(line: string): void;
}

const PREFIX_LENGTH = 15;

export function supabaseFetch(fake: FakeSupabase): Fetch {
  return async (url, init) => {
    const world = fake.world.load();
    const { pathname, searchParams } = new URL(url);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const missing = () => reply(404, { message: "API key not found for project" });
    if (fake.admin !== undefined && init.headers.Authorization !== `Bearer ${fake.admin}`)
      return reply(401, { message: "Unauthorized" });
    const keys = `/v1/projects/${fake.projectRef}/api-keys`;
    if (!pathname.startsWith(keys)) return reply(403, { message: "Forbidden resource" });
    const reveal = searchParams.get("reveal") === "true" && !fake.hideValues && !fake.prefixOnly;
    const shown = (key: SupabaseKey) => ({
      id: key.id,
      name: key.name,
      type: key.type,
      prefix: key.type === "legacy" ? "OxwOz" : key.value.slice(0, PREFIX_LENGTH),
      api_key:
        reveal || key.type !== "secret"
          ? key.value
          : fake.prefixOnly
            ? key.value.slice(0, PREFIX_LENGTH)
            : `${key.value.slice(0, PREFIX_LENGTH)}··························`,
      secret_jwt_template:
        key.type === "secret" ? (key.template ?? { role: "service_role" }) : null,
      hash: "not-checked",
      description: null,
    });
    if (init.method === "GET" && pathname === keys) {
      if (fake.failList !== undefined) return reply(fake.failList, { message: "refused" });
      return reply(200, world.keys.map(shown));
    }
    if (init.method === "POST" && pathname === keys) {
      if (fake.failCreate !== undefined)
        return reply(fake.failCreate, { message: `refused ${init.headers.Authorization}` });
      const asked: unknown = JSON.parse(init.body ?? "{}");
      const name = isRecord(asked) && typeof asked.name === "string" ? asked.name : "";
      if (!isRecord(asked) || asked.type !== "secret" || !/^[a-z_][a-z0-9_]{3,63}$/.test(name))
        return reply(400, { message: "invalid body" });
      if (world.keys.some((key) => key.name === name)) return reply(409, { message: "name taken" });
      const made = world.created + 1;
      const key: SupabaseKey = {
        id: `key-new-${made}`,
        name,
        type: "secret",
        value: `${fake.valuePrefix}${made}_c4e1`,
      };
      fake.world.save({ keys: [...world.keys, key], created: made });
      fake.effect(`supabase create ${key.id}`);
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(201, shown(key));
    }
    const id = decodeURIComponent(pathname.slice(keys.length + 1));
    const key = world.keys.find((listed) => listed.id === id);
    if (!key) return missing();
    if (init.method === "GET") return reply(200, shown(key));
    if (init.method !== "DELETE") return missing();
    fake.world.save({ ...world, keys: world.keys.filter((listed) => listed.id !== id) });
    fake.effect(`supabase revoke ${id}`);
    return reply(200, shown(key));
  };
}

export function memoryWorld(keys: SupabaseKey[]) {
  let world: SupabaseWorld = { keys: [...keys], created: 0 };
  return { load: () => world, save: (next: SupabaseWorld) => void (world = next) };
}

export interface FakeSecrets {
  token: string;
  username: string | null;
  projects: Record<string, Record<string, string>>;
  readOnly?: boolean;
  failWrites?: number;
}

export function secretsFetch(fake: FakeSecrets) {
  const effects: string[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch: Fetch = async (url, init) => {
    const { pathname } = new URL(url);
    if (init.headers.Authorization !== `Bearer ${fake.token}`)
      return reply(401, { message: "Unauthorized" });
    if (pathname === "/v1/profile")
      return fake.username === null
        ? reply(403, { message: "Forbidden resource" })
        : reply(200, { gotrue_id: "u1", primary_email: "a@example.com", username: fake.username });
    const [, ref = ""] = /^\/v1\/projects\/([^/]+)\/secrets$/.exec(pathname) ?? [];
    const secrets = fake.projects[decodeURIComponent(ref)];
    if (!secrets) return reply(403, { message: "Forbidden resource" });
    if (init.method === "GET")
      return reply(
        200,
        Object.keys(secrets).map((name) => ({ name, value: `digest-${name.length}` })),
      );
    if (init.method !== "POST") return reply(405, { message: "Method not allowed" });
    if (fake.readOnly) return reply(403, { message: "Forbidden resource" });
    const sent: unknown = JSON.parse(init.body ?? "[]");
    const items = Array.isArray(sent) ? sent.filter(isRecord) : [];
    if (fake.failWrites !== undefined)
      return reply(fake.failWrites, {
        message: `could not store ${items.map((i) => String(i.value)).join(", ")}`,
      });
    if (
      !items.length ||
      items.some((i) => typeof i.name !== "string" || i.name.startsWith("SUPABASE_"))
    )
      return reply(400, { message: "Secret name must not start with the SUPABASE_ prefix." });
    for (const { name, value } of items) {
      const verb = Object.hasOwn(secrets, String(name)) ? "update" : "create";
      secrets[String(name)] = String(value);
      effects.push(`supabase secret ${verb} ${ref} ${String(name)}`);
    }
    return reply(201, null);
  };
  return { fetch, effects };
}
