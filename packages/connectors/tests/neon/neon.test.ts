import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, parseMap, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { NeonIssuer, neonIssuer } from "../../src/neon/index";
import { type FakeNeon, memoryWorld, neonFetch } from "../../src/neon/testing";

const ADMIN = "napi_admin_sentinel_6b2e";
const PREFIX = "npg_issued_sentinel_";
const LIVE_A = "npg_live_a_sentinel_3c9d";
const LIVE_B = "npg_live_b_sentinel_8e1f";
const HOST = "ep-quiet-1.us-east-2.aws.neon.tech";
const urlFor = (role: string, password: string, host = HOST) =>
  new Secret(`postgresql://${role}:${password}@${host}/appdb?sslmode=require`);

function neon(
  options: Partial<FakeNeon> = {},
  roles: Record<string, string> = { app_a: LIVE_A, app_b: LIVE_B },
) {
  const effects: string[] = [];
  const requests: string[] = [];
  const world = memoryWorld(roles);
  const fake: FakeNeon = {
    admin: ADMIN,
    projectId: "proj-1",
    branchId: "br-main",
    database: "appdb",
    host: HOST,
    passwordPrefix: PREFIX,
    world,
    effect: (line) => void effects.push(line),
    ...options,
  };
  const served = neonFetch(fake);
  const fetch: Fetch = (url, init) => {
    requests.push(`${init.method} ${url.replace("https://console.neon.tech/api/v2", "")}`);
    return served(url, init);
  };
  const issuer = () =>
    new NeonIssuer({
      admin: async () => new Secret(ADMIN),
      projectId: "proj-1",
      branchId: "br-main",
      database: "appdb",
      roles: ["app_a", "app_b"],
      fetch,
      sleep: async () => undefined,
    });
  return { issuer, effects, requests, world, fake };
}

function expectNoSecret(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  for (const secret of [ADMIN, PREFIX, LIVE_A, LIVE_B]) expect(text).not.toContain(secret);
}

describe("which role keypin resets", () => {
  test("the first rotation resets the role the vault's URL doesn't use, and offers to revoke the other", async () => {
    const { issuer, effects } = neon();
    const neonB = issuer();
    const check = await neonB.checkAccount(null, urlFor("app_b", LIVE_B));
    expect(check).toMatchObject({
      ok: true,
      facts: "roles app_a and app_b, database appdb; the vault uses app_b",
      currentId: "app_b@2026-11-15T12:00:00Z",
    });
    expect(check.notes?.revoke).toBe(
      "resets the password of role app_b: every connection string that uses app_b stops working, and every open connection drops",
    );
    const created = await neonB.create();
    expect(effects).toEqual(["neon reset app_a"]);
    expect(created.id).toBe("app_a@2026-11-15T12:00:01Z");
    expect(created.secret.reveal()).toBe(
      `postgresql://app_a:${PREFIX}1@${HOST}/appdb?sslmode=require`,
    );
    expectNoSecret(check, created.id, neonB.describe(), neonB.dashboard());
  });

  test("rotations alternate: each one resets the idle role, then revokes the one the vault used", async () => {
    const { issuer, effects } = neon();
    let url = urlFor("app_a", LIVE_A);
    let currentId: string | null = null;
    for (const _ of [1, 2, 3]) {
      const each = issuer();
      const check = await each.checkAccount(currentId, url);
      assert(check.ok);
      const old = currentId ?? check.currentId;
      assert(old);
      const created = await each.create();
      expect(await each.revoke(old)).toBe("revoked");
      url = created.secret;
      currentId = created.id;
    }
    expect(effects).toEqual([
      "neon reset app_b",
      "neon reset app_a",
      "neon reset app_a",
      "neon reset app_b",
      "neon reset app_b",
      "neon reset app_a",
    ]);
  });

  test("revoke resets only the old role, and only while its password is the one keypin knew", async () => {
    const { issuer, effects, world } = neon();
    const each = issuer();
    const check = await each.checkAccount(null, urlFor("app_a", LIVE_A));
    const created = await each.create();
    const passwordB = world.load().roles.app_b?.password;
    expect(await each.revoke(check.currentId ?? "")).toBe("revoked");
    expect(effects).toEqual(["neon reset app_b", "neon reset app_a"]);
    expect(world.load().roles.app_b?.password).toBe(passwordB);
    expect(await each.revoke(check.currentId ?? "")).toBe("already gone");
    expect(await each.revoke("app_gone@2026-11-15T12:00:00Z")).toBe("already gone");
    expect(created.id.startsWith("app_b@")).toBe(true);
  });

  test("keypin's key stays listed while the vault holds the other role's URL, but neither role is reset", async () => {
    const { issuer, effects, requests } = neon();
    const each = issuer();
    const check = await each.checkAccount("app_b@2026-11-15T12:00:00Z", urlFor("app_a", LIVE_A));
    expect(check).toMatchObject({ ok: true });
    expect(check.notes).toBeUndefined();
    const error: unknown = await each.create().catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toContain("won't reset Neon role app_a: the URL in the vault uses it");
    expect(effects).toEqual([]);
    expect(requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    expectNoSecret(error);
  });

  test("a role another rotation reset after checkAccount stops create before its reset", async () => {
    const { issuer, effects, world } = neon();
    const each = issuer();
    expect((await each.checkAccount(null, urlFor("app_a", LIVE_A))).ok).toBe(true);
    const other = issuer();
    await other.checkAccount(null, urlFor("app_a", LIVE_A));
    const theirs = await other.create();
    const error: unknown = await each.create().catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe(
      "Neon role app_b's password changed at 2026-11-15T12:00:01Z, after keypin checked it, so another rotation may be running. Run rotate again",
    );
    expect(effects).toEqual(["neon reset app_b"]);
    expect(world.load().roles.app_b?.password).toBe(theirs.secret.reveal().split(/[:@]/)[2]);
    expectNoSecret(error);
  });

  test("a reset that another rotation overtakes during create returns no password", async () => {
    const { fake, world } = neon();
    const served = neonFetch(fake);
    const fetch: Fetch = async (url, init) => {
      const response = await served(url, init);
      if (init.method === "POST") {
        const changed = world.load();
        const roleB = changed.roles.app_b;
        assert(roleB);
        roleB.resets++;
        world.save(changed);
      }
      return response;
    };
    const each = new NeonIssuer({
      admin: async () => new Secret(ADMIN),
      projectId: "proj-1",
      branchId: "br-main",
      database: "appdb",
      roles: ["app_a", "app_b"],
      fetch,
      sleep: async () => undefined,
    });
    await each.checkAccount(null, urlFor("app_a", LIVE_A));
    const error: unknown = await each.create().catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe(
      "Neon role app_b's password changed again at 2026-11-15T12:00:02Z, during keypin's reset, so another rotation may be running. Run rotate again",
    );
    expectNoSecret(error);
  });

  test("a password someone reset after keypin set it stops the rotation", async () => {
    const { issuer, world } = neon();
    const changed = world.load();
    const roleB = changed.roles.app_b;
    assert(roleB);
    roleB.resets = 7;
    world.save(changed);
    const check = await issuer().checkAccount(
      "app_b@2026-11-15T12:00:00Z",
      urlFor("app_b", LIVE_B),
    );
    expect(check).toMatchObject({ ok: false });
    expect(check.reason).toContain("role app_b's password changed at 2026-11-15T12:00:07Z");
    expectNoSecret(check);
  });

  test("a pooled URL stays pooled, and keeps the vault's query", async () => {
    const { issuer } = neon();
    const each = issuer();
    const pooled = new Secret(
      `postgresql://app_a:${LIVE_A}@ep-quiet-1-pooler.us-east-2.aws.neon.tech/appdb?sslmode=verify-full`,
    );
    await each.checkAccount(null, pooled);
    const created = await each.create();
    expect(created.secret.reveal()).toBe(
      `postgresql://app_b:${PREFIX}1@ep-quiet-1-pooler.us-east-2.aws.neon.tech/appdb?sslmode=verify-full`,
    );
  });

  test("a URL for a read replica keeps that replica's host, pooled or not", async () => {
    const replica = "ep-replica-2.us-east-2.aws.neon.tech";
    for (const host of [replica, replica.replace(".", "-pooler.")]) {
      const { issuer } = neon({ endpoints: ["ep-quiet-1", "ep-replica-2"] });
      const each = issuer();
      expect((await each.checkAccount(null, urlFor("app_a", LIVE_A, host))).ok).toBe(true);
      const created = await each.create();
      expect(created.secret.reveal()).toBe(
        `postgresql://app_b:${PREFIX}1@${host}/appdb?sslmode=require`,
      );
    }
  });
});

describe("the reset operation", () => {
  test("create waits for every operation the reset started to finish", async () => {
    const { issuer, requests } = neon({ pollsToFinish: 3 });
    const each = issuer();
    await each.checkAccount(null, urlFor("app_a", LIVE_A));
    await each.create();
    const resetAt = requests.indexOf(
      "POST /projects/proj-1/branches/br-main/roles/app_b/reset_password",
    );
    expect(requests.slice(resetAt + 1)).toEqual([
      "GET /projects/proj-1/operations/op-1",
      "GET /projects/proj-1/operations/op-1",
      "GET /projects/proj-1/operations/op-1",
      "GET /projects/proj-1/branches/br-main/roles/app_b",
    ]);
  });

  test("an operation that fails stops create, without a password", async () => {
    const { issuer } = neon({ failReset: "operation" });
    const each = issuer();
    await each.checkAccount(null, urlFor("app_a", LIVE_A));
    const error: unknown = await each.create().catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe(
      "Neon's password reset for role app_b ended failed (operation apply_config op-1)",
    );
    expectNoSecret(error);
  });

  test("a refused reset throws without the admin key", async () => {
    const { issuer } = neon({ failReset: "refuse" });
    const each = issuer();
    await each.checkAccount(null, urlFor("app_a", LIVE_A));
    const error: unknown = await each.create().catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe(
      "Neon POST /roles/app_b/reset_password returned HTTP 500 INTERNAL_ERROR",
    );
    expectNoSecret(error);
  });

  test("a reset a read-only key may not make says to use an Editor or Admin key", async () => {
    const { issuer, effects } = neon({ readOnly: true });
    const each = issuer();
    expect((await each.checkAccount(null, urlFor("app_a", LIVE_A))).ok).toBe(true);
    const error: unknown = await each.create().catch((e: unknown) => e);
    assert(error instanceof NothingChanged);
    expect(error.message).toBe(
      "Neon refused to reset role app_b's password (HTTP 404): the admin key can read project proj-1 but may not change it. Use an API key with Editor or Admin access to the project; see https://neon.com/docs/manage/user-permissions",
    );
    expect(effects).toEqual([]);
    expectNoSecret(error);
  });

  test("a role deleted between the check and the reset is named, not blamed on the admin key", async () => {
    const { issuer, effects } = neon({ failReset: "role gone" });
    const each = issuer();
    expect((await each.checkAccount(null, urlFor("app_a", LIVE_A))).ok).toBe(true);
    const error: unknown = await each.create().catch((e: unknown) => e);
    assert(error instanceof NothingChanged);
    expect(error.message).toBe("Neon role app_b is gone from branch br-main");
    expect(effects).toEqual([]);
    expectNoSecret(error);
  });

  test("a lost reset says the idle role's password may have changed and a rerun is safe", async () => {
    const { issuer } = neon();
    const each = issuer();
    await each.checkAccount(null, urlFor("app_a", LIVE_A));
    expect(each.lostCreate()).toBe(
      "Neon may have reset the password of role app_b before the reply was lost. Nothing uses that role yet, so running this again is safe.",
    );
  });

  test("a project busy with another operation (423) is retried", async () => {
    const { issuer, effects } = neon({ locked: 2 });
    const each = issuer();
    await each.checkAccount(null, urlFor("app_a", LIVE_A));
    await each.create();
    expect(effects).toEqual(["neon reset app_b"]);
  });
});

describe("checkAccount", () => {
  test("a role missing from the branch is named, and create then rejects", async () => {
    const { issuer, effects } = neon({}, { app_a: LIVE_A, other: LIVE_B });
    const each = issuer();
    const check = await each.checkAccount(null, urlFor("app_a", LIVE_A));
    expect(check).toMatchObject({
      ok: false,
      reason: "Neon branch br-main has no role app_b",
      fix: "create app_b with SQL, in the same group role as the other (see docs/configuration.md#neon)",
    });
    await expect(each.create()).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
  });

  test("a key with Viewer access to the project fails the check, before any reset", async () => {
    const { issuer, effects } = neon({ permission: "VIEWER" });
    const each = issuer();
    expect(await each.checkAccount(null, urlFor("app_a", LIVE_A))).toEqual({
      ok: false,
      facts: "the admin key has Viewer access to project proj-1",
      reason: "the admin key can read Neon project proj-1 but can't reset passwords in it",
      fix: "use an API key with Editor or Admin access to the project; see https://neon.com/docs/manage/user-permissions",
    });
    await expect(each.create()).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
    const editor = await neon({ permission: "EDITOR" })
      .issuer()
      .checkAccount(null, urlFor("app_a", LIVE_A));
    expect(editor.ok).toBe(true);
  });

  test("a wrong database or branch is named", async () => {
    const database = await neon({ database: "otherdb" })
      .issuer()
      .checkAccount(null, urlFor("app_a", LIVE_A));
    expect(database.reason).toBe("Neon branch br-main has no database appdb");
    const branch = await neon({ branchId: "br-other" })
      .issuer()
      .checkAccount(null, urlFor("app_a", LIVE_A));
    expect(branch.reason).toBe("Neon project proj-1 has no branch br-main");
  });

  test("a wrong admin key or project", async () => {
    const wrongKey = await neon({ admin: "napi_other" })
      .issuer()
      .checkAccount(null, urlFor("app_a", LIVE_A));
    expect(wrongKey).toMatchObject({ ok: false, facts: "Neon answered HTTP 401 UNAUTHORIZED" });
    const wrongProject = await neon({ projectId: "proj-2" })
      .issuer()
      .checkAccount(null, urlFor("app_a", LIVE_A));
    expect(wrongProject.reason).toContain("can't reach Neon project proj-1");
    expectNoSecret(wrongKey, wrongProject);
  });

  const refusals: [string, string | null, Secret, string][] = [
    [
      "a vault value that isn't a URL",
      null,
      new Secret("not-a-url-sentinel"),
      "the vault's value isn't a postgresql:// URL",
    ],
    [
      "a vault URL for a role keypin doesn't manage",
      null,
      urlFor("app_owner", LIVE_A),
      "the vault's URL uses role app_owner, not app_a or app_b",
    ],
    [
      "a vault URL for an unmanaged role, with an ID from last time",
      "app_a@2026-11-15T12:00:00Z",
      urlFor("app_owner", LIVE_A),
      "the vault's URL uses role app_owner, not app_a or app_b",
    ],
    [
      "a malformed vault URL, with an ID from last time",
      "app_b@2026-11-15T12:00:00Z",
      new Secret("postgresql://%zz@"),
      "the vault's value isn't a postgresql:// URL",
    ],
    [
      "a vault URL for another database",
      null,
      new Secret(`postgresql://app_a:${LIVE_A}@${HOST}/otherdb`),
      "the vault's URL connects to database otherdb, not appdb",
    ],
    [
      "a vault URL for a compute of another branch",
      null,
      urlFor("app_a", LIVE_A, "ep-elsewhere-9.us-east-2.aws.neon.tech"),
      "the vault's URL connects to ep-elsewhere-9, which isn't a compute of Neon branch br-main",
    ],
  ];
  for (const [what, currentId, vault, reason] of refusals)
    test(`${what} fails the check, and nothing is reset`, async () => {
      const { issuer, effects, requests } = neon();
      const each = issuer();
      const check = await each.checkAccount(currentId, vault);
      expect(check).toMatchObject({ ok: false, reason });
      await expect(each.create()).rejects.toThrow("checkAccount hasn't passed");
      expect(effects).toEqual([]);
      expect(requests.filter((r) => r.startsWith("POST"))).toEqual([]);
      expectNoSecret(check);
    });
});

describe("keypin.toml", () => {
  const twoKeys = (second: string) => `
[1password]
account = "my.1password.com"

[keys.DATABASE_URL.prod]
from = "op://Private/app database/password"
issuer = { kind = "neon", admin = "op://Private/neon api key/credential", project_id = "proj-1", branch_id = "br-main", database = "appdb", roles = ["app_a", "app_b"] }

[keys.DIRECT_URL.prod]
from = "op://Private/app direct database/password"
issuer = { kind = "neon", admin = "op://Private/neon api key/credential", ${second} }
`;
  const parseTwo = (second: string) =>
    parseMap(twoKeys(second), "/w/keypin.toml", [], [neonIssuer], [onePasswordVault]);

  test("two keys whose issuers reset the same role are refused, naming both", () => {
    const parsed = parseTwo(
      `project_id = "proj-1", branch_id = "br-main", database = "appdb", roles = ["app_b", "app_c"]`,
    );
    assert(!parsed.ok);
    expect(parsed.errors).toEqual([
      `/w/keypin.toml: key "DIRECT_URL" prod issuer: key "DATABASE_URL" prod also rotates role app_b on Neon branch br-main of project proj-1, so rotating either key breaks the other. Change one issuer so they share nothing, or remove one`,
    ]);
  });

  test("other roles, another branch or another project don't share a role", () => {
    for (const second of [
      `project_id = "proj-1", branch_id = "br-main", database = "appdb", roles = ["app_c", "app_d"]`,
      `project_id = "proj-1", branch_id = "br-dev", database = "appdb", roles = ["app_a", "app_b"]`,
      `project_id = "proj-2", branch_id = "br-main", database = "appdb", roles = ["app_a", "app_b"]`,
    ])
      expect(parseTwo(second).ok).toBe(true);
  });

  const map = (roles: string) => `
[1password]
account = "my.1password.com"

[keys.DATABASE_URL.prod]
from = "op://Private/app database/password"
issuer = { kind = "neon", admin = "op://Private/neon api key/credential", project_id = "proj-1", branch_id = "br-main", database = "appdb", roles = ${roles} }
`;
  const parse = (roles: string) =>
    parseMap(map(roles), "/w/keypin.toml", [], [neonIssuer], [onePasswordVault]);

  test("reads the issuer table", () => {
    const parsed = parse(`["app_a", "app_b"]`);
    assert(parsed.ok);
    expect(parsed.map.keys[0]?.environments.prod?.issuer).toMatchObject({
      kind: "neon",
      projectId: "proj-1",
      branchId: "br-main",
      database: "appdb",
      roles: ["app_a", "app_b"],
    });
  });

  test("roles must be two different names", () => {
    for (const roles of [`["app_a"]`, `["app_a", "app_a"]`, `["a", "b", "c"]`, `"app_a"`]) {
      const parsed = parse(roles);
      expect(parsed.ok).toBe(false);
      assert(!parsed.ok);
      expect(parsed.errors.join("\n")).toMatch(/field "roles" must/);
    }
  });
});
