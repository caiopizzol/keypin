import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, readSecretspec, RevokeRefused, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { AtlasIssuer, type AtlasIssuerOptions, atlasIssuer } from "../../src/mongodb-atlas/index";
import { nextName } from "../../src/mongodb-atlas/atlas";
import {
  atlasFetch,
  type FakeAtlas,
  type FakeAtlasUser,
  memoryWorld,
} from "../../src/mongodb-atlas/testing";
import { parseUri, withUser } from "../../src/mongodb-atlas/uri";

const PROJECT = "5f1a2b3c4d5e6f7a8b9c0d1e";
const CLIENT = "mdb_sa_id_6745";
const SECRET = "mdb_sa_sk_admin_sentinel_5c1f";
const OLD_PASSWORD = "vault_sentinel_2f4b";
const NEW_PASSWORD = "issued/sentinel:8a2d@x";
const HOST = "cluster0.ab1cd.mongodb.net";
const VAULT = `mongodb+srv://app:${OLD_PASSWORD}@${HOST}/appdb?retryWrites=true&w=majority&appName=Cluster0`;
const APP: FakeAtlasUser = {
  username: "app",
  password: OLD_PASSWORD,
  roles: [
    { roleName: "readWrite", databaseName: "appdb" },
    { roleName: "read", databaseName: "reports", collectionName: "daily" },
  ],
  scopes: [{ name: "Cluster0", type: "CLUSTER" }],
};

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function setup(
  fake: Partial<FakeAtlas> = {},
  options: Partial<AtlasIssuerOptions> = {},
  users: FakeAtlasUser[] = [APP],
) {
  const effects: string[] = [];
  const requests: Seen[] = [];
  const sleeps: number[] = [];
  const world = memoryWorld(users.map((user) => ({ ...user })));
  const inner = atlasFetch({
    clientId: CLIENT,
    secret: SECRET,
    projectId: PROJECT,
    clusters: [
      {
        name: "Cluster0",
        srvHost: HOST,
        hosts: ["cluster0-shard-00-00.ab1cd.mongodb.net", "cluster0-shard-00-01.ab1cd.mongodb.net"],
      },
    ],
    world,
    effect: (line) => void effects.push(line),
    ...fake,
  });
  const fetch: Fetch = async (url, init) => {
    requests.push({ method: init.method, url, headers: init.headers, body: init.body ?? "" });
    return inner(url, init);
  };
  const atlas = new AtlasIssuer({
    admin: async () => new Secret(SECRET),
    clientId: CLIENT,
    projectId: PROJECT,
    fetch,
    password: () => NEW_PASSWORD,
    sleep: async (ms) => void sleeps.push(ms),
    ...options,
  });
  return { atlas, effects, requests, world, sleeps };
}

async function passed(atlas: AtlasIssuer, id: string | null = null, vault = VAULT) {
  const check = await atlas.checkAccount(id, new Secret(vault));
  assert(check.ok, JSON.stringify(check));
  return check;
}

async function refused(atlas: AtlasIssuer, id: string | null = null, vault = VAULT) {
  const check = await atlas.checkAccount(id, new Secret(vault));
  assert(!check.ok, JSON.stringify(check));
  return check;
}

describe("connection strings", () => {
  test("keeps the hosts, ports, database and options, and percent-encodes the new user", () => {
    const uri = parseUri(
      "mongodb://app%40corp:p%3Ass@h1.example.net:27017,h2.example.net:27018/appdb?ssl=true&replicaSet=atlas-x&authSource=admin",
    );
    assert(uri);
    expect(uri.username).toBe("app@corp");
    expect(uri.hosts).toEqual(["h1.example.net:27017", "h2.example.net:27018"]);
    expect(withUser(uri, "app@corp-b", "a/b:c@d?e")).toBe(
      "mongodb://app%40corp-b:a%2Fb%3Ac%40d%3Fe@h1.example.net:27017,h2.example.net:27018/appdb?ssl=true&replicaSet=atlas-x&authSource=admin",
    );
  });

  test("reads a mongodb+srv:// string with no database or options", () => {
    const uri = parseUri(`mongodb+srv://app:pw@${HOST.toUpperCase()}`);
    assert(uri);
    expect(uri.hosts).toEqual([HOST]);
    expect(withUser(uri, "app-b", "new")).toBe(`mongodb+srv://app-b:new@${HOST.toUpperCase()}`);
  });

  test("refuses a string without a username and password", () => {
    expect(parseUri(`mongodb+srv://${HOST}/appdb`)).toBeNull();
    expect(parseUri(`mongodb+srv://app@${HOST}/appdb`)).toBeNull();
    expect(parseUri(`postgresql://app:pw@${HOST}/appdb`)).toBeNull();
  });

  test("new users alternate between -a and -b, so the name never grows", () => {
    expect(nextName("app")).toBe("app-b");
    expect(nextName("app-b")).toBe("app-a");
    expect(nextName("app-a")).toBe("app-b");
    expect(nextName("app-c")).toBe("app-c-b");
  });
});

describe("rotation", () => {
  test("creates a user with the old user's roles and scopes, and saves the URL with it", async () => {
    const { atlas, effects, requests } = setup({ pendingPolls: 2 });
    const check = await passed(atlas);
    expect(check).toMatchObject({
      facts: "the service account reaches project app; cluster Cluster0, user app",
      currentId: "app",
      notes: { create: "creates database user app-b with app's roles and scopes" },
    });
    const created = await atlas.create();
    expect(created.id).toBe("app-b");
    expect(created.secret.reveal()).toBe(
      `mongodb+srv://app-b:${encodeURIComponent(NEW_PASSWORD)}@${HOST}/appdb?retryWrites=true&w=majority&appName=Cluster0`,
    );
    expect(effects).toEqual(["atlas create app-b with readWrite@appdb,read@reports on Cluster0"]);
    const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/databaseUsers"));
    assert(post);
    expect(post.headers["Content-Type"]).toBe("application/vnd.atlas.2023-01-01+json");
    expect(JSON.parse(post.body)).toEqual({
      username: "app-b",
      password: NEW_PASSWORD,
      databaseName: "admin",
      groupId: PROJECT,
      roles: APP.roles,
      scopes: APP.scopes,
    });
    const polls = requests.filter((r) => r.url.endsWith("/clusters/Cluster0/status"));
    expect(polls).toHaveLength(3);
  });

  test("the next rotation goes back to -a, and revoke deletes the old user", async () => {
    const { atlas, effects, world } = setup();
    await passed(atlas);
    const first = await atlas.create();
    await passed(atlas, first.id, first.secret.reveal());
    expect(await atlas.revoke("app", first.secret)).toBe("revoked");
    expect(await atlas.revoke("app", first.secret)).toBe("already gone");
    const check = await passed(atlas, "app-b", first.secret.reveal());
    expect(check).not.toHaveProperty("currentId");
    const second = await atlas.create();
    expect(second.id).toBe("app-a");
    expect(world.load().users.map((user) => user.username)).toEqual(["app-b", "app-a"]);
    expect(effects).toEqual([
      "atlas create app-b with readWrite@appdb,read@reports on Cluster0",
      "atlas delete app",
      "atlas create app-a with readWrite@appdb,read@reports on Cluster0",
    ]);
  });

  test("a standard mongodb:// string finds the cluster by its shard hosts", async () => {
    const { atlas } = setup();
    await passed(
      atlas,
      null,
      `mongodb://app:${OLD_PASSWORD}@cluster0-shard-00-00.ab1cd.mongodb.net:27017,cluster0-shard-00-01.ab1cd.mongodb.net:27017/?ssl=true&authSource=admin`,
    );
  });

  test("a private endpoint shared by two clusters finds the cluster by its ports", async () => {
    const endpoint = "pl-0-us-east-1.ab1cd.mongodb.net";
    const { atlas, requests, sleeps } = setup(
      {
        clusters: [
          {
            name: "ClusterA",
            srvHost: "a.ab1cd.mongodb.net",
            hosts: [`${endpoint}:1024`, `${endpoint}:1025`],
            applied: true,
          },
          {
            name: "ClusterB",
            srvHost: "b.ab1cd.mongodb.net",
            hosts: [`${endpoint}:1027`, `${endpoint}:1028`],
          },
        ],
        pendingPolls: 2,
      },
      {},
      [{ ...APP, scopes: [{ name: "ClusterB", type: "CLUSTER" }] }],
    );
    const check = await passed(
      atlas,
      null,
      `mongodb://app:${OLD_PASSWORD}@${endpoint}:1027,${endpoint}:1028/?ssl=true`,
    );
    expect(check.facts).toContain("cluster ClusterB");
    await atlas.create();
    const polled = requests
      .filter((r) => r.url.includes("/status"))
      .map((r) => r.url.split("/").at(-2));
    expect(polled).toEqual(["ClusterB", "ClusterB", "ClusterB"]);
    expect(sleeps).toHaveLength(2);
  });

  test("a connection string that matches two clusters is refused", async () => {
    const endpoint = "pl-0-us-east-1.ab1cd.mongodb.net";
    const { atlas } = setup({
      clusters: [
        { name: "ClusterA", srvHost: "a.ab1cd.mongodb.net", hosts: [`${endpoint}:1024`] },
        { name: "ClusterB", srvHost: "b.ab1cd.mongodb.net", hosts: [`${endpoint}:1027`] },
      ],
    });
    const check = await refused(
      atlas,
      null,
      `mongodb://app:pw@${endpoint}:1024,${endpoint}:1027/?ssl=true`,
    );
    expect(check.reason).toBe(
      `the vault's connection string connects to ${endpoint}:1024,${endpoint}:1027, which matches clusters ClusterA, ClusterB in project app`,
    );
  });

  test("a Flex cluster gets the user without waiting on a status", async () => {
    const { atlas, requests } = setup({
      clusters: [{ name: "Flex0", srvHost: "flex0.zz9yy.mongodb.net", flex: true }],
    });
    await passed(atlas, null, `mongodb+srv://app:${OLD_PASSWORD}@flex0.zz9yy.mongodb.net/`);
    await atlas.create();
    expect(requests.some((r) => r.url.includes("/status"))).toBe(false);
  });

  test("a user the cluster never applies is deleted, and nothing changed", async () => {
    const { atlas, effects, world } = setup({ pendingPolls: 1000 });
    await passed(atlas);
    const error = await atlas.create().catch((e: unknown) => e);
    assert(error instanceof NothingChanged);
    expect(error.message).toBe(
      "Atlas didn't finish adding database user app-b to cluster Cluster0 in time, so keypin deleted it. Run this again later",
    );
    expect(effects).toEqual([
      "atlas create app-b with readWrite@appdb,read@reports on Cluster0",
      "atlas delete app-b",
    ]);
    expect(world.load().users.map((user) => user.username)).toEqual(["app"]);
  });

  test("signs in once and reuses the token until it expires", async () => {
    let now = 0;
    const { atlas, requests } = setup({}, { now: () => now });
    await passed(atlas);
    await passed(atlas);
    const tokens = () => requests.filter((r) => r.url.endsWith("/api/oauth/token")).length;
    expect(tokens()).toBe(1);
    now = 3_600_000;
    await passed(atlas);
    expect(tokens()).toBe(2);
    const token = requests.find((r) => r.url.endsWith("/api/oauth/token"));
    expect(token?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`,
    );
  });
});

describe("refusals", () => {
  test("a programmatic API key is refused before any request", async () => {
    const { atlas, requests } = setup(
      {},
      { admin: async () => new Secret("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0") },
    );
    const check = await refused(atlas);
    expect(check.facts).toBe("the admin item holds the private key of a programmatic API key");
    expect(check.fix).toContain("client_id");
    expect(requests).toEqual([]);
  });

  test("a secret Atlas rejects names the client ID", async () => {
    const { atlas } = setup({ secret: "mdb_sa_sk_other" });
    const check = await refused(atlas);
    expect(check.reason).toBe(
      `Atlas doesn't accept service account ${CLIENT}: its secret expired or was revoked, or the item holds another value`,
    );
    expect(JSON.stringify(check)).not.toContain(SECRET);
  });

  test("a project the service account can't reach", async () => {
    const { atlas } = setup({ projectId: "000000000000000000000000" });
    const check = await refused(atlas);
    expect(check.facts).toBe("Atlas answered HTTP 404 GROUP_NOT_FOUND");
    expect(check.fix).toContain("check project_id in secretspec.toml");
  });

  test("a vault value that isn't a connection string", async () => {
    const check = await refused(setup().atlas, null, "postgresql://app:pw@host/db");
    expect(check.reason).toBe(
      "the vault's value isn't a mongodb+srv:// or mongodb:// connection string with a username and password",
    );
  });

  test("a connection string that signs in with X.509 or AWS IAM", async () => {
    const x509 = await refused(
      setup().atlas,
      null,
      `mongodb+srv://CN%3Dapp:x@${HOST}/?authMechanism=MONGODB-X509`,
    );
    expect(x509.reason).toBe(
      "the vault's connection string signs in with MONGODB-X509, which has no password keypin can rotate",
    );
    const aws = await refused(
      setup().atlas,
      null,
      `mongodb+srv://AKIA:secret@${HOST}/?authSource=%24external&authMechanism=MONGODB-AWS`,
    );
    expect(aws.reason).toContain("MONGODB-AWS");
  });

  test("a cluster in another project", async () => {
    const check = await refused(
      setup().atlas,
      null,
      `mongodb+srv://app:pw@other.zz9yy.mongodb.net/`,
    );
    expect(check.reason).toBe(
      "the vault's connection string connects to other.zz9yy.mongodb.net, which isn't a cluster in project app",
    );
  });

  test("a user the project doesn't have", async () => {
    const check = await refused(setup({}, {}, []).atlas);
    expect(check.reason).toBe(
      "project app has no password user app, the vault's user: it was deleted, or it isn't a password user",
    );
  });

  test("a user with an external sign-in has no password", async () => {
    const { atlas } = setup({}, {}, [{ ...APP, ldapAuthType: "USER" }]);
    const check = await refused(atlas);
    expect(check.reason).toBe(
      "user app signs in with USER (ldapAuthType), which has no password keypin can rotate",
    );
  });

  test("a temporary user", async () => {
    const { atlas } = setup({}, {}, [{ ...APP, deleteAfterDate: "2026-11-20T00:00:00Z" }]);
    const check = await refused(atlas);
    expect(check.reason).toBe("user app is temporary: Atlas deletes it on 2026-11-20T00:00:00Z");
  });
});

describe("create errors", () => {
  test("after a lost reply, the rerun finds the new user and creates nothing", async () => {
    const lost = setup({ loseCreated: true });
    await passed(lost.atlas);
    await expect(lost.atlas.create()).rejects.toThrow("fetch failed");
    expect(lost.atlas.lostCreate()).toBe(
      `MongoDB Atlas may have created database user app-b before the reply was lost. Nothing uses it yet. Delete it at https://cloud.mongodb.com/v2/${PROJECT}#/security/database/users, then run this again; keypin won't create a user that already exists.`,
    );
    const rerun = setup({}, {}, lost.world.load().users);
    await passed(rerun.atlas);
    const error = await rerun.atlas.create().catch((e: unknown) => e);
    assert(error instanceof NothingChanged);
    expect(error.message).toContain(
      "database user app-b, the name keypin gives the user after app, already exists",
    );
    expect(rerun.effects).toEqual([]);
  });

  test("a full project is a NothingChanged that names the limit", async () => {
    const { atlas } = setup({ userLimit: 1 });
    await passed(atlas);
    const error = await atlas.create().catch((e: unknown) => e);
    assert(error instanceof NothingChanged);
    expect(error.message).toContain("HTTP 403 DATABASE_USER_LIMIT_EXCEEDED");
    expect(error.message).toContain("database user limit (100 unless raised)");
  });

  test("a race to the same name is a NothingChanged", async () => {
    const { atlas, world } = setup();
    await passed(atlas);
    world.load().users.push({ ...APP, username: "app-b" });
    const inner = atlasFetch({
      clientId: CLIENT,
      secret: SECRET,
      projectId: PROJECT,
      clusters: [{ name: "Cluster0", srvHost: HOST }],
      world,
      effect: () => undefined,
    });
    const racing = new AtlasIssuer({
      admin: async () => new Secret(SECRET),
      clientId: CLIENT,
      projectId: PROJECT,
      fetch: async (url, init) =>
        init.method === "GET" && url.endsWith("/databaseUsers/admin/app-b")
          ? new Response("{}", { status: 404 })
          : inner(url, init),
    });
    await passed(racing);
    const error = await racing.create().catch((e: unknown) => e);
    assert(error instanceof NothingChanged);
    expect(error.message).toContain("Atlas says database user app-b already exists");
  });

  test("a service account that can't change users", async () => {
    const { atlas } = setup({ readOnly: true }, {}, [APP, { ...APP, username: "app-a" }]);
    await passed(atlas);
    const error = await atlas.create().catch((e: unknown) => e);
    assert(error instanceof NothingChanged);
    expect(error.message).toContain("lacks Project Database Access Admin");
    await expect(atlas.revoke("app-a", new Secret(VAULT))).rejects.toThrow(
      "the service account can't delete database user app-a",
    );
  });
});

describe("revoke checks the user with Atlas", () => {
  const ADMIN: FakeAtlasUser = {
    username: "dbadmin",
    password: "admin_password",
    roles: [{ roleName: "atlasAdmin", databaseName: "admin" }],
  };
  const deletes = (requests: Seen[]) => requests.filter((r) => r.method === "DELETE");

  test("refuses the user the vault's connection string signs in as", async () => {
    const { atlas, effects, requests } = setup();
    await passed(atlas);
    const error = await atlas.revoke("app", new Secret(VAULT)).catch((e: unknown) => e);
    assert(error instanceof RevokeRefused);
    expect(error.message).toBe("it's the database user the vault's connection string signs in as");
    expect(deletes(requests)).toEqual([]);
    expect(effects).toEqual([]);
  });

  test("refuses a user keypin doesn't rotate the vault's user through", async () => {
    const { atlas, effects, requests } = setup({}, {}, [APP, ADMIN]);
    await passed(atlas);
    const error = await atlas.revoke("dbadmin", new Secret(VAULT)).catch((e: unknown) => e);
    assert(error instanceof RevokeRefused);
    expect(error.message).toBe(
      "its name isn't app, app-a or app-b, the names keypin gives the vault's user app",
    );
    expect(deletes(requests)).toEqual([]);
    expect(effects).toEqual([]);
  });

  test("a user the project doesn't have is already gone, with no delete", async () => {
    const { atlas, requests } = setup();
    await passed(atlas);
    expect(await atlas.revoke("app-b", new Secret(VAULT))).toBe("already gone");
    expect(deletes(requests)).toEqual([]);
  });

  test("checkAccount refuses a recorded user the vault doesn't sign in as, and copies nothing", async () => {
    const { atlas, effects } = setup({}, {}, [APP, ADMIN]);
    const check = await refused(atlas, "dbadmin");
    expect(check.reason).toBe(
      "user dbadmin, the one keypin recorded for the vault's value, isn't app, the user the vault's connection string signs in as",
    );
    expect(check.fix).toBe("check .keypin/rotation.json for a change you didn't make");
    await expect(atlas.create()).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
  });

  test("has reads the user without checkAccount, and an Atlas error is an error", async () => {
    const { atlas } = setup();
    expect(await atlas.has("app")).toBe(true);
    expect(await atlas.has("app-b")).toBe(false);
    const { atlas: failing } = setup(
      {},
      {
        fetch: async (url, init) =>
          url.includes("/databaseUsers/")
            ? new Response("{}", { status: 500 })
            : atlasFetch({
                clientId: CLIENT,
                secret: SECRET,
                projectId: PROJECT,
                clusters: [],
                world: memoryWorld([]),
                effect: () => undefined,
              })(url, init),
      },
    );
    const error = await failing.has("app").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe("Atlas GET /databaseUsers/admin/<username> returned HTTP 500");
  });
});

describe("the map", () => {
  const map = (issuer: string) => `[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
MONGODB_URI = { description = "MONGODB_URI", ref = { item = "app mongodb uri", field = "password" } }

[tool.keypin.prod.MONGODB_URI.issuer]
kind = "mongodb-atlas"
admin = "op://Private/atlas service account/credential"
${issuer}`;
  const parse = (text: string) =>
    readSecretspec(text, "secretspec.toml", [], [atlasIssuer], [onePasswordVault]);

  test("takes the client ID and project ID", () => {
    const parsed = parse(map(`client_id = "${CLIENT}"\nproject_id = "${PROJECT}"\n`));
    assert(parsed.ok, JSON.stringify(parsed));
    expect(parsed.map.keys[0]?.environments.prod?.issuer).toMatchObject({
      kind: "mongodb-atlas",
      clientId: CLIENT,
      projectId: PROJECT,
    });
  });

  test("needs both fields", () => {
    const parsed = parse(map(""));
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain(`missing field "client_id"`);
    expect(parsed.errors.join("\n")).toContain(`missing field "project_id"`);
  });

  test("refuses a project name where the ID belongs", () => {
    const parsed = parse(map(`client_id = "${CLIENT}"\nproject_id = "app"\n`));
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain(
      `field "project_id" must be the 24-character project ID from the project's settings`,
    );
  });
});
