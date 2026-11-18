import type { Fetch } from "@keypin/core";

export type FakeKeyType = "main" | "standard" | "restricted";

export interface FakeTwilioKey {
  sid: string;
  secret: string;
  name: string;
  type: FakeKeyType;
  account?: string;
  policy?: readonly string[];
}

export interface TwilioWorld {
  keys: FakeTwilioKey[];
  created: number;
}

export interface FakeTwilio {
  account: string;
  authToken: string;
  sidPrefix: string;
  valuePrefix: string;
  failCreate?: number;
  loseCreated?: boolean;
  world: { load(): TwilioWorld; save(world: TwilioWorld): void };
  effect(line: string): void;
}

const API = "https://api.twilio.com";
const IAM = "https://iam.twilio.com";

function keyJson(key: FakeTwilioKey) {
  return {
    sid: key.sid,
    friendly_name: key.name,
    date_created: "Mon, 16 Nov 2026 12:00:00 +0000",
    date_updated: "Mon, 16 Nov 2026 12:00:00 +0000",
    policy: key.type === "restricted" ? { allow: key.policy ?? [] } : null,
  };
}

export function twilioFetch(fake: FakeTwilio): Fetch {
  return async (url, init) => {
    const world = fake.world.load();
    const { origin, pathname, searchParams } = new URL(url);
    const reply = (status: number, body?: object) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status });
    const error = (status: number, code: number, message: string) =>
      reply(status, {
        code,
        message,
        more_info: `https://www.twilio.com/docs/errors/${code}`,
        status,
      });
    const basic = /^Basic (.+)$/.exec(init.headers.Authorization ?? "")?.[1] ?? "";
    const [user = "", password = ""] = atob(basic).split(":");
    const signer = world.keys.find((k) => k.sid === user && k.secret === password);
    const caller =
      user === fake.account && password === fake.authToken
        ? { account: fake.account, type: "main" as const, policy: undefined }
        : signer
          ? { account: signer.account ?? fake.account, type: signer.type, policy: signer.policy }
          : null;
    if (caller === null) return error(401, 20003, "Authenticate");
    const allows = (permission: string) =>
      caller.type === "main" ||
      (caller.type === "restricted" && caller.policy?.includes(permission));
    const deny = () =>
      caller.type === "restricted"
        ? error(403, 70051, "Authorization Failed")
        : error(401, 20003, "Authenticate");

    if (origin === API) {
      const available =
        /^\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/AvailablePhoneNumbers\.json$/.exec(pathname);
      if (init.method !== "GET" || !available) return error(404, 20404, "not found");
      if (available[1] !== caller.account) return error(403, 20003, "Permission Denied");
      if (
        caller.type === "restricted" &&
        !caller.policy?.some((p) => p.startsWith("/twilio/phone-numbers/"))
      )
        return error(403, 70051, "Authorization Failed");
      return reply(200, { countries: [], uri: pathname });
    }
    if (origin !== IAM) return error(404, 20404, "not found");

    const mine = (key: FakeTwilioKey) => (key.account ?? fake.account) === caller.account;
    if (pathname === "/v1/Keys" && init.method === "GET") {
      if (!allows("/twilio/iam/api-keys/list")) return deny();
      if (searchParams.get("AccountSid") !== caller.account)
        return error(403, 20003, "Permission Denied");
      const keys = world.keys
        .filter(mine)
        .map(({ sid, name }) => ({ sid, friendly_name: name, flags: ["rest_api", "signing"] }));
      return reply(200, { keys, meta: { key: "keys", next_page_url: null } });
    }

    if (pathname === "/v1/Keys" && init.method === "POST") {
      if (!allows("/twilio/iam/api-keys/create")) return deny();
      const form = new URLSearchParams(init.body ?? "");
      if (form.get("AccountSid") !== caller.account) return error(403, 20003, "Permission Denied");
      if (fake.failCreate !== undefined)
        return error(fake.failCreate, 20500, `refused ${init.headers.Authorization}`);
      const name = form.get("FriendlyName") ?? "";
      if (name.length > 64) return error(400, 20001, "FriendlyName is too long");
      const restricted = form.get("KeyType") === "restricted";
      const policy: unknown = restricted ? JSON.parse(form.get("Policy") ?? "null") : null;
      const allow =
        typeof policy === "object" &&
        policy !== null &&
        "allow" in policy &&
        Array.isArray(policy.allow)
          ? policy.allow.filter((p): p is string => typeof p === "string")
          : null;
      if (restricted && allow === null) return error(400, 20001, "Policy is required");
      const made = world.created + 1;
      const key: FakeTwilioKey = {
        sid: `${fake.sidPrefix}${String(made).padStart(34 - fake.sidPrefix.length, "0")}`,
        secret: `${fake.valuePrefix}${made}x`,
        name,
        type: restricted ? "restricted" : "standard",
        ...(allow === null ? {} : { policy: allow }),
        ...(caller.account === fake.account ? {} : { account: caller.account }),
      };
      fake.world.save({ keys: [...world.keys, key], created: made });
      fake.effect(
        `twilio create ${key.sid} ${key.type}${allow === null ? "" : ` with ${allow.join(",")}`}`,
      );
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(201, { ...keyJson(key), secret: key.secret });
    }

    const one = /^\/v1\/Keys\/([^/]+)$/.exec(pathname);
    if (!one) return error(404, 20404, "not found");
    const key = world.keys.find((k) => k.sid === one[1] && mine(k));
    if (init.method === "GET") {
      if (!allows("/twilio/iam/api-keys/read")) return deny();
      if (!key) return error(404, 20404, "The requested resource was not found");
      return reply(200, keyJson(key));
    }
    if (init.method === "DELETE") {
      if (!allows("/twilio/iam/api-keys/delete")) return deny();
      if (!key) return error(404, 20404, "The requested resource was not found");
      fake.world.save({ ...world, keys: world.keys.filter((k) => k !== key) });
      fake.effect(`twilio delete ${key.sid}`);
      return reply(204);
    }
    return error(405, 20004, "Method not allowed");
  };
}

export function adminJson(credentials: Record<string, string>): string {
  return JSON.stringify(credentials, null, 2);
}

export function memoryWorld(keys: FakeTwilioKey[] = []) {
  let world: TwilioWorld = { keys: [...keys], created: 0 };
  return { load: () => world, save: (next: TwilioWorld) => void (world = next) };
}
