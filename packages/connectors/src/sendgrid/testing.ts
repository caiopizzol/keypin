import { type Fetch, isRecord } from "@keypin/core";

export interface FakeSendGridKey {
  id: string;
  name: string;
  value: string;
  scopes: readonly string[];
  subuser?: string;
}

export interface SendGridWorld {
  keys: FakeSendGridKey[];
  created: number;
}

export interface FakeSendGrid {
  admin: string;
  adminScopes?: readonly string[];
  region?: "eu";
  subusers?: readonly string[];
  valuePrefix: string;
  failCreate?: number;
  loseCreated?: boolean;
  world: {
    load(): SendGridWorld;
    save(world: SendGridWorld): void;
  };
  effect(line: string): void;
}

const LIMIT = 100;

export function sendgridFetch(fake: FakeSendGrid): Fetch {
  return async (url, init) => {
    const { keys, created } = fake.world.load();
    const { origin, pathname } = new URL(url);
    const reply = (status: number, body?: object) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status });
    const error = (status: number, message: string) =>
      reply(status, { errors: [{ field: null, message }] });
    const host = fake.region === "eu" ? "https://api.eu.sendgrid.com" : "https://api.sendgrid.com";
    const token = (init.headers.Authorization ?? "").replace(/^Bearer /, "");
    if (origin !== host || token !== fake.admin) return error(401, "authorization required");
    const scopes = fake.adminScopes ?? ADMIN_SCOPES;
    const has = (scope: string) => scopes.includes(scope);

    if (init.method === "GET" && pathname === "/v3/scopes") return reply(200, { scopes });

    const behalf = init.headers["on-behalf-of"];
    if (behalf !== undefined && !fake.subusers?.includes(behalf))
      return error(403, "access forbidden");
    const mine = (key: FakeSendGridKey) => key.subuser === behalf;

    if (init.method === "POST" && pathname === "/v3/api_keys") {
      if (!has("api_keys.create")) return error(403, "access forbidden");
      if (fake.failCreate !== undefined) return error(fake.failCreate, `refused ${token}`);
      if (keys.filter(mine).length >= LIMIT) return error(403, "too many API keys");
      const asked: unknown = JSON.parse(init.body ?? "{}");
      const wanted =
        isRecord(asked) && Array.isArray(asked.scopes)
          ? asked.scopes.filter((scope): scope is string => typeof scope === "string")
          : scopes.filter((scope) => !AUTOMATIC.includes(scope));
      if (wanted.some((scope) => !has(scope)))
        return error(403, "cannot grant scopes the key does not have");
      const name = isRecord(asked) && typeof asked.name === "string" ? asked.name : "";
      if (!name) return error(400, "missing name");
      const id = `NewKey${created + 1}Id`;
      const value = `SG.${id}.${fake.valuePrefix}${created + 1}${VALUE_END}`;
      const scopesNow = [...wanted, ...AUTOMATIC];
      fake.world.save({
        keys: [
          ...keys,
          {
            id,
            name,
            value,
            scopes: scopesNow,
            ...(behalf === undefined ? {} : { subuser: behalf }),
          },
        ],
        created: created + 1,
      });
      fake.effect(
        `sendgrid create ${id}${behalf === undefined ? "" : ` for ${behalf}`} with ${wanted.join(",")}`,
      );
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(201, { api_key: value, api_key_id: id, name, scopes: scopesNow });
    }

    const one = /^\/v3\/api_keys\/([^/]+)$/.exec(pathname);
    const id = decodeURIComponent(one?.[1] ?? "");
    const key = keys.find((listed) => listed.id === id && mine(listed));
    if (init.method === "GET" && one) {
      if (!has("api_keys.read")) return error(403, "access forbidden");
      if (!key) return error(404, "unable to find API Key");
      return reply(200, { result: [{ api_key_id: key.id, name: key.name, scopes: key.scopes }] });
    }
    if (init.method === "DELETE" && one) {
      if (!has("api_keys.delete")) return error(403, "access forbidden");
      if (!key) return error(404, "unable to find API Key");
      fake.world.save({ keys: keys.filter((listed) => listed !== key), created });
      fake.effect(`sendgrid revoke ${id}${behalf === undefined ? "" : ` for ${behalf}`}`);
      return reply(204);
    }
    return error(404, "not found");
  };
}

const VALUE_END = "x9Qa";
const AUTOMATIC = ["sender_verification_eligible", "2fa_required"];
export const ADMIN_SCOPES: readonly string[] = [
  "api_keys.create",
  "api_keys.read",
  "api_keys.update",
  "api_keys.delete",
  "mail.send",
  "mail.batch.read",
  "templates.read",
  "stats.read",
  ...AUTOMATIC,
];

export function memoryWorld(initial: FakeSendGridKey[] = []) {
  let world: SendGridWorld = { keys: [...initial], created: 0 };
  return { load: () => world, save: (next: SendGridWorld) => void (world = next) };
}
