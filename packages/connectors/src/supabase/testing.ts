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
