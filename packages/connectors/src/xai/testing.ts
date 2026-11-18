import { type Fetch, isRecord } from "@keypin/core";

export interface FakeXaiKey {
  id: string;
  name: string;
  value: string;
  team?: string;
  disabled?: boolean;
  blocked?: boolean;
  acls?: readonly string[];
  qps?: number;
  qpm?: number;
  tpm?: string;
  lifetimeDays?: number;
  owner?: string;
  pendingPolls?: number;
}

export interface XaiWorld {
  keys: FakeXaiKey[];
  created: number;
}

export interface FakeXai {
  admin: string;
  team: string;
  scope?: "team" | "organization";
  teams?: readonly string[];
  member?: string;
  denied?: readonly ("list" | "create" | "delete" | "propagation")[];
  valuePrefix: string;
  pageSize?: number;
  pendingPolls?: number;
  failCreate?: number;
  loseCreated?: boolean;
  world: { load(): XaiWorld; save(world: XaiWorld): void };
  effect(line: string): void;
}

const CREATED_AT = "2026-01-01T00:00:00Z";
const DAY = 86_400_000;
const VALUE_END = "_9c4e";
const CLUSTERS = ["us-east-1.api.x.ai", "eu-west-1.api.x.ai"];

export function redacted(value: string): string {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function xaiFetch(fake: FakeXai): Fetch {
  return async (url, init) => {
    const { keys, created } = fake.world.load();
    const { host, pathname, searchParams } = new URL(url);
    const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });
    const error = (status: number, message: string) =>
      reply(status, { code: status, error: `${message} ${init.headers.Authorization}` });
    const token = (init.headers.Authorization ?? "").replace(/^Bearer /, "");
    const teamOf = (key: FakeXaiKey) => key.team ?? fake.team;

    if (host === "api.x.ai") {
      if (pathname !== "/v1/api-key" || init.method !== "GET") return error(404, "Not Found");
      const key = keys.find((k) => k.value === token);
      if (!key) return error(400, "Incorrect API key provided");
      return reply(200, {
        redacted_api_key: redacted(key.value),
        user_id: key.owner ?? "user_admin",
        name: key.name,
        team_id: teamOf(key),
        acls: key.acls ?? ["api-key:model:*", "api-key:endpoint:*"],
        api_key_id: key.id,
        team_blocked: false,
        api_key_blocked: key.blocked === true,
        api_key_disabled: key.disabled === true,
      });
    }
    if (host !== "management-api.x.ai") return error(404, "Not Found");
    if (token !== fake.admin) return error(401, "Invalid management key");
    const denied = (what: NonNullable<FakeXai["denied"]>[number]) =>
      fake.denied?.includes(what) === true;
    const teams = fake.scope === "organization" ? (fake.teams ?? [fake.team]) : [fake.team];

    if (pathname === "/auth/management-keys/validation" && init.method === "GET")
      return reply(200, {
        apiKeyId: "mgmt_1",
        teamId: fake.team,
        scope: fake.scope === "organization" ? "SCOPE_ORGANIZATION" : "SCOPE_TEAM",
        scopeId: fake.scope === "organization" ? "org_1" : fake.team,
        name: "keypin",
        acls: [],
        redactedApiKey: redacted(fake.admin),
      });

    const inTeam = /^\/auth\/teams\/([^/]+)\/api-keys$/.exec(pathname);
    const team = decodeURIComponent(inTeam?.[1] ?? "");
    if (inTeam && !teams.includes(team)) return error(403, "Not allowed for this team");
    if (inTeam && init.method === "GET") {
      if (denied("list")) return error(403, "Missing ListApiKeys");
      const size = Math.min(Number(searchParams.get("pageSize") ?? 1000), fake.pageSize ?? 1000);
      const from = Number(searchParams.get("paginationToken") ?? 0);
      const shown = keys.filter(
        (k) => teamOf(k) === team && (fake.member === undefined || k.owner === fake.member),
      );
      const page = shown.slice(from, from + size);
      return reply(200, {
        apiKeys: page.map((k) => listed(k, teamOf(k))),
        ...(from + size < shown.length ? { paginationToken: String(from + size) } : {}),
      });
    }
    if (inTeam && init.method === "POST") {
      if (denied("create")) return error(403, "Missing CreateApiKey");
      if (fake.failCreate !== undefined) return error(fake.failCreate, "Internal Server Error");
      const asked: unknown = JSON.parse(init.body ?? "{}");
      if (!isRecord(asked) || typeof asked.name !== "string" || !asked.name)
        return error(400, "name is required");
      const id = `key_new${created + 1}`;
      const value = `${fake.valuePrefix}${created + 1}${VALUE_END}`;
      const acls = Array.isArray(asked.acls)
        ? asked.acls.filter((acl): acl is string => typeof acl === "string")
        : [];
      const expires = typeof asked.expireTime === "string" ? asked.expireTime : null;
      const key: FakeXaiKey = {
        id,
        name: asked.name,
        value,
        team,
        acls,
        ...(typeof asked.qps === "number" ? { qps: asked.qps } : {}),
        ...(typeof asked.qpm === "number" ? { qpm: asked.qpm } : {}),
        ...(typeof asked.tpm === "string" ? { tpm: asked.tpm } : {}),
        pendingPolls: fake.pendingPolls ?? 0,
      };
      fake.world.save({ keys: [...keys, key], created: created + 1 });
      const settings = [
        `acls ${acls.join(" ") || "none"}`,
        ...(key.qps === undefined ? [] : [`qps ${key.qps}`]),
        ...(key.qpm === undefined ? [] : [`qpm ${key.qpm}`]),
        ...(key.tpm === undefined ? [] : [`tpm ${key.tpm}`]),
        ...(expires === null ? [] : [`expires ${expires}`]),
      ];
      fake.effect(`xai create ${id} in ${team} with ${settings.join(", ")}`);
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(200, { ...listed(key, team), apiKey: value });
    }

    const propagation = /^\/auth\/api-keys\/([^/]+)\/propagation$/.exec(pathname);
    if (propagation && init.method === "GET") {
      if (denied("propagation")) return error(403, "Missing CheckApiKeyPropagation");
      const id = decodeURIComponent(propagation[1] ?? "");
      const key = keys.find((k) => k.id === id && teams.includes(teamOf(k)));
      if (!key) return error(404, "API key not found");
      const pending = key.pendingPolls ?? 0;
      if (pending > 0)
        fake.world.save({
          keys: keys.map((k) => (k.id === id ? { ...k, pendingPolls: pending - 1 } : k)),
          created,
        });
      return reply(200, {
        icPropagation: Object.fromEntries(
          CLUSTERS.map((cluster, i) => [cluster, pending === 0 || i === 0]),
        ),
      });
    }

    const one = /^\/auth\/api-keys\/([^/]+)$/.exec(pathname);
    if (one && init.method === "DELETE") {
      if (denied("delete")) return error(403, "Missing DeleteApiKey");
      const id = decodeURIComponent(one[1] ?? "");
      if (!keys.some((k) => k.id === id && teams.includes(teamOf(k))))
        return error(404, "API key not found");
      fake.world.save({ keys: keys.filter((k) => k.id !== id), created });
      fake.effect(`xai revoke ${id}`);
      return reply(200, {});
    }
    return error(404, "Not Found");
  };
}

function listed(key: FakeXaiKey, team: string) {
  return {
    redactedApiKey: redacted(key.value),
    userId: key.owner ?? "user_admin",
    name: key.name,
    createTime: CREATED_AT,
    modifyTime: CREATED_AT,
    teamId: team,
    apiKeyId: key.id,
    disabled: key.disabled === true,
    ...(key.lifetimeDays === undefined
      ? {}
      : { expireTime: new Date(Date.parse(CREATED_AT) + key.lifetimeDays * DAY).toISOString() }),
    ...(key.qps === undefined ? {} : { qps: key.qps }),
    ...(key.qpm === undefined ? {} : { qpm: key.qpm }),
    ...(key.tpm === undefined ? {} : { tpm: key.tpm }),
    aclStrings: key.acls ?? ["api-key:model:*", "api-key:endpoint:*"],
  };
}

export function memoryWorld(initial: FakeXaiKey[] = []) {
  let world: XaiWorld = { keys: [...initial], created: 0 };
  return { load: () => world, save: (next: XaiWorld) => void (world = next) };
}
