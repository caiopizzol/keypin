import { type Fetch, isRecord } from "@keypin/core";

export interface FakeElevenLabsKey {
  account: string;
  keyId: string;
  name: string;
  value: string;
  disabled?: boolean;
  permissions?: string[] | null;
  characterLimit?: number;
  allowedIps?: string[];
  thirdPartyDisable?: boolean;
  limits?: Record<string, { limit: number | null }>;
  lifetimeDays?: number;
  expiresAt?: number;
}

export interface ElevenLabsWorld {
  keys: FakeElevenLabsKey[];
  created: number;
}

export interface FakeElevenLabs {
  admin: string;
  adminLacksPermission?: boolean;
  valuePrefix: string;
  accounts: readonly { id: string; name: string }[];
  people?: readonly { id: string; value: string }[];
  failCreate?: number;
  loseCreated?: boolean;
  world: { load(): ElevenLabsWorld; save(world: ElevenLabsWorld): void };
  effect(line: string): void;
}

const CREATED_AT = 1_767_225_600;
const DAY = 86_400;
const VALUE_END = "9c4e";
export const ALL = ["text_to_speech", "voices_read", "user_read"];

export function elevenlabsFetch(fake: FakeElevenLabs): Fetch {
  return async (url, init) => {
    const { keys, created } = fake.world.load();
    const { pathname } = new URL(url);
    const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });
    const denied = (status: number, code: string, message: string) =>
      reply(status, {
        detail: {
          type: "authentication_error",
          code: status === 401 && code === "missing_permissions" ? "unauthorized" : code,
          status: code,
          message: `${message} ${init.headers["xi-api-key"]}`,
        },
      });
    const token = init.headers["xi-api-key"] ?? "";

    if (pathname === "/v1/user" && init.method === "GET") {
      const person = fake.people?.find((p) => p.value === token);
      if (person) return reply(200, { user_id: person.id, subscription: {} });
      if (token === fake.admin) return reply(200, { user_id: "admin_person", subscription: {} });
      const key = keys.find((k) => k.value === token);
      if (!key || key.disabled) return denied(401, "invalid_api_key", "Invalid API key");
      const permissions = key.permissions === undefined ? ALL : key.permissions;
      if (permissions !== null && !permissions.includes("user_read"))
        return denied(
          401,
          "missing_permissions",
          "The API key you used is missing the permission user_read to execute this operation.",
        );
      return reply(200, { user_id: key.account, subscription: {} });
    }
    if (token !== fake.admin) return denied(401, "invalid_api_key", "Invalid API key");
    if (fake.adminLacksPermission)
      return denied(
        401,
        "missing_permissions",
        "The API key you used is missing the permission service_account_write to execute this operation.",
      );

    if (pathname === "/v1/service-accounts" && init.method === "GET")
      return reply(200, {
        "service-accounts": fake.accounts.map((account) => ({
          service_account_user_id: account.id,
          name: account.name,
          "api-keys": keys.filter((k) => k.account === account.id).map(listed),
        })),
      });
    const many = /^\/v1\/service-accounts\/([^/]+)\/api-keys$/.exec(pathname);
    const account = fake.accounts.find((a) => a.id === decodeURIComponent(many?.[1] ?? ""));
    if (many && !account) return reply(404, { detail: { code: "not_found", status: "not_found" } });
    if (many && account && init.method === "GET")
      return reply(200, { "api-keys": keys.filter((k) => k.account === account.id).map(listed) });
    if (many && account && init.method === "POST") {
      if (fake.failCreate !== undefined)
        return reply(fake.failCreate, { detail: { code: "internal_error", message: token } });
      const asked: unknown = JSON.parse(init.body ?? "{}");
      if (!isRecord(asked) || typeof asked.name !== "string" || !Array.isArray(asked.permissions))
        return reply(422, { detail: [{ msg: "name and permissions are required" }] });
      const keyId = `key_new${created + 1}`;
      const value = `${fake.valuePrefix}${created + 1}${VALUE_END}`;
      const limits: Record<string, { limit: number }> = {};
      for (const [field, limit] of [
        ["tts_concurrency_limit", "concurrency"],
        ["dubbing_concurrency_limit", "dubbing_concurrency"],
        ["music_concurrency_limit", "music_concurrency"],
      ] as const) {
        const value = asked[field];
        if (typeof value === "number") limits[limit] = { limit: value };
      }
      const key: FakeElevenLabsKey = {
        account: account.id,
        keyId,
        name: asked.name,
        value,
        permissions: asked.permissions.filter((p): p is string => typeof p === "string"),
        ...(typeof asked.character_limit === "number"
          ? { characterLimit: asked.character_limit }
          : {}),
        ...(Array.isArray(asked.allowed_ips)
          ? { allowedIps: asked.allowed_ips.filter((ip): ip is string => typeof ip === "string") }
          : {}),
        ...(typeof asked.third_party_disable_allowed === "boolean"
          ? { thirdPartyDisable: asked.third_party_disable_allowed }
          : {}),
        ...(Object.keys(limits).length ? { limits } : {}),
        ...(typeof asked.expires_at_unix === "number" ? { expiresAt: asked.expires_at_unix } : {}),
      };
      fake.world.save({ keys: [...keys, key], created: created + 1 });
      const settings = [
        `permissions ${key.permissions?.join(",")}`,
        ...(key.characterLimit === undefined ? [] : [`limit ${key.characterLimit}`]),
        ...(key.allowedIps ? [`ips ${key.allowedIps.join(",")}`] : []),
        ...(key.thirdPartyDisable === undefined
          ? []
          : [`third-party disable ${key.thirdPartyDisable}`]),
        ...Object.entries(limits).map(([name, { limit }]) => `${name} ${limit}`),
        ...(key.expiresAt === undefined ? [] : [`expires ${key.expiresAt}`]),
      ];
      fake.effect(`elevenlabs create ${account.id}/${keyId} with ${settings.join(", ")}`);
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(200, { "xi-api-key": value, key_id: keyId });
    }
    const one = /^\/v1\/service-accounts\/([^/]+)\/api-keys\/([^/]+)$/.exec(pathname);
    const found = keys.find(
      (k) =>
        k.account === decodeURIComponent(one?.[1] ?? "") &&
        k.keyId === decodeURIComponent(one?.[2] ?? ""),
    );
    if (one && init.method === "DELETE" && found) {
      fake.world.save({ keys: keys.filter((k) => k !== found), created });
      fake.effect(`elevenlabs revoke ${found.account}/${found.keyId}`);
      return reply(200, {});
    }
    return reply(404, { detail: { code: "not_found", status: "not_found" } });
  };
}

function listed(key: FakeElevenLabsKey) {
  const expires =
    key.expiresAt ?? (key.lifetimeDays === undefined ? null : CREATED_AT + key.lifetimeDays * DAY);
  return {
    name: key.name,
    hint: key.value.slice(-4),
    key_id: key.keyId,
    service_account_user_id: key.account,
    hashed_xi_api_key: `hashed_${key.keyId}`,
    created_at_unix: key.expiresAt === undefined ? CREATED_AT : key.expiresAt - 30 * DAY,
    is_disabled: key.disabled === true,
    permissions: key.permissions === undefined ? ALL : key.permissions,
    disable_reason: key.disabled ? "exposed_publicly" : null,
    character_limit: key.characterLimit ?? null,
    character_count: 0,
    allowed_ips: key.allowedIps ?? null,
    third_party_disable_allowed: key.thirdPartyDisable ?? null,
    platform_limits: key.limits ?? null,
    expires_at_unix: expires,
  };
}

export function memoryWorld(initial: FakeElevenLabsKey[] = []) {
  let world: ElevenLabsWorld = { keys: [...initial], created: 0 };
  return { load: () => world, save: (next: ElevenLabsWorld) => void (world = next) };
}
