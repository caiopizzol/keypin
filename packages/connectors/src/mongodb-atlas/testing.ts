import { type Fetch, isRecord } from "@keypin/core";

export interface FakeAtlasUser {
  username: string;
  password: string;
  roles: { roleName: string; databaseName: string; collectionName?: string }[];
  scopes?: { name: string; type: "CLUSTER" | "DATA_LAKE" | "STREAM" }[];
  x509Type?: string;
  awsIAMType?: string;
  ldapAuthType?: string;
  oidcAuthType?: string;
  deleteAfterDate?: string;
}

export interface FakeAtlasCluster {
  name: string;
  srvHost: string;
  hosts?: string[];
  flex?: boolean;
  applied?: boolean;
}

export interface AtlasWorld {
  users: FakeAtlasUser[];
  created: number;
  pending: number;
}

export interface FakeAtlas {
  clientId: string;
  secret: string;
  projectId: string;
  projectName?: string;
  clusters: FakeAtlasCluster[];
  pendingPolls?: number;
  failCreate?: number;
  loseCreated?: boolean;
  readOnly?: boolean;
  userLimit?: number;
  world: {
    load(): AtlasWorld;
    save(world: AtlasWorld): void;
  };
  effect(line: string): void;
}

const TOKEN = "atlas-fake-access-token";

export function atlasFetch(fake: FakeAtlas): Fetch {
  return async (url, init) => {
    const world = fake.world.load();
    const { pathname, origin } = new URL(url);
    const reply = (status: number, body?: object) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status });
    const error = (status: number, errorCode: string, detail: string) =>
      reply(status, { error: status, errorCode, detail, reason: "" });
    if (origin !== "https://cloud.mongodb.com") return error(404, "NOT_FOUND", "no such host");

    if (pathname === "/api/oauth/token") {
      const basic = `Basic ${Buffer.from(`${fake.clientId}:${fake.secret}`).toString("base64")}`;
      if (init.method !== "POST" || init.body !== "grant_type=client_credentials")
        return reply(400, { error: "invalid_request" });
      if (init.headers.Authorization !== basic) return reply(401, { error: "invalid_client" });
      return reply(200, { access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });
    }
    if (init.headers.Authorization !== `Bearer ${TOKEN}`)
      return error(401, "NOT_ORG_GROUP_CREATOR", "Current user is not authorized.");
    const project = `/api/atlas/v2/groups/${fake.projectId}`;
    if (!pathname.startsWith(project))
      return error(404, "GROUP_NOT_FOUND", "No group with this ID exists.");
    const rest = pathname.slice(project.length);
    const version = /^application\/vnd\.atlas\.(\d{4}-\d{2}-\d{2})\+json$/.exec(
      init.headers.Accept ?? "",
    )?.[1];
    if (!version) return error(406, "INVALID_VERSION", "missing or unknown version");

    if (init.method === "GET" && rest === "")
      return reply(200, { id: fake.projectId, name: fake.projectName ?? "app" });
    if (init.method === "GET" && rest === "/clusters")
      return reply(200, {
        results: fake.clusters
          .filter((cluster) => !cluster.flex)
          .map((cluster) => ({
            name: cluster.name,
            connectionStrings: {
              standardSrv: `mongodb+srv://${cluster.srvHost}`,
              standard: `mongodb://${(cluster.hosts ?? []).map((host) => (/:\d+$/.test(host) ? host : `${host}:27017`)).join(",")}/?ssl=true`,
            },
          })),
        totalCount: fake.clusters.length,
      });
    if (init.method === "GET" && rest === "/flexClusters")
      return reply(200, {
        results: fake.clusters
          .filter((cluster) => cluster.flex)
          .map((cluster) => ({
            name: cluster.name,
            connectionStrings: { standardSrv: `mongodb+srv://${cluster.srvHost}` },
          })),
      });
    const status = /^\/clusters\/([^/]+)\/status$/.exec(rest);
    if (init.method === "GET" && status) {
      const cluster = fake.clusters.find((one) => one.name === decodeURIComponent(status[1] ?? ""));
      if (!cluster) return error(404, "CLUSTER_NOT_FOUND", "No cluster with this name exists.");
      if (cluster.applied) return reply(200, { changeStatus: "APPLIED" });
      const changeStatus = world.pending > 0 ? "PENDING" : "APPLIED";
      if (world.pending > 0) world.pending--;
      fake.world.save(world);
      return reply(200, { changeStatus });
    }

    const shown = (user: FakeAtlasUser) => {
      const { password: _password, ...visible } = user;
      return { databaseName: "admin", groupId: fake.projectId, labels: [], ...visible };
    };
    if (init.method === "POST" && rest === "/databaseUsers") {
      const body: unknown = JSON.parse(init.body ?? "{}");
      if (!isRecord(body) || typeof body.username !== "string" || typeof body.password !== "string")
        return error(400, "INVALID_ATTRIBUTE", "username and password are required");
      if (fake.readOnly)
        return error(
          401,
          "USER_UNAUTHORIZED",
          "Current user is not authorized to perform this action.",
        );
      if (world.users.some((user) => user.username === body.username))
        return error(409, "USER_ALREADY_EXISTS", "A user with this username already exists.");
      if (world.users.length >= (fake.userLimit ?? 100))
        return error(
          403,
          "DATABASE_USER_LIMIT_EXCEEDED",
          "Groups can contain at most 100 database users.",
        );
      if (fake.failCreate)
        return error(fake.failCreate, "UNEXPECTED_ERROR", `refused ${init.headers.Authorization}`);
      const user: FakeAtlasUser = {
        username: body.username,
        password: body.password,
        roles: records(body.roles).map((role) => ({
          roleName: String(role.roleName),
          databaseName: String(role.databaseName),
          ...(typeof role.collectionName === "string"
            ? { collectionName: role.collectionName }
            : {}),
        })),
        ...(Array.isArray(body.scopes)
          ? {
              scopes: records(body.scopes).map((scope) => ({
                name: String(scope.name),
                type:
                  scope.type === "DATA_LAKE" || scope.type === "STREAM" ? scope.type : "CLUSTER",
              })),
            }
          : {}),
      };
      world.users.push(user);
      world.created++;
      world.pending = fake.pendingPolls ?? 0;
      fake.world.save(world);
      fake.effect(
        `atlas create ${user.username} with ${user.roles.map((role) => `${role.roleName}@${role.databaseName}`).join(",")}${user.scopes?.length ? ` on ${user.scopes.map((scope) => scope.name).join(",")}` : ""}`,
      );
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(201, shown(user));
    }
    const one = /^\/databaseUsers\/(admin|%24external|\$external)\/([^/]+)$/.exec(rest);
    if (!one) return error(404, "RESOURCE_NOT_FOUND", "Cannot find resource.");
    const username = decodeURIComponent(one[2] ?? "");
    const index = world.users.findIndex((user) => user.username === username && one[1] === "admin");
    const found = world.users[index];
    if (!found) return error(404, "USERNAME_NOT_FOUND", "No user with this username exists.");
    if (init.method === "GET") return reply(200, shown(found));
    if (init.method === "DELETE") {
      if (fake.readOnly)
        return error(
          401,
          "USER_UNAUTHORIZED",
          "Current user is not authorized to perform this action.",
        );
      world.users.splice(index, 1);
      world.pending = fake.pendingPolls ?? 0;
      fake.world.save(world);
      fake.effect(`atlas delete ${username}`);
      return reply(204);
    }
    return error(405, "METHOD_NOT_ALLOWED", "method not allowed");
  };
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function memoryWorld(users: FakeAtlasUser[]) {
  let world: AtlasWorld = { users, created: 0, pending: 0 };
  return { load: () => world, save: (next: AtlasWorld) => void (world = next) };
}
