import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, readSecretspec, RevokeRefused, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { XaiIssuer, xaiIssuer } from "../../src/xai/index";
import { type FakeXai, type FakeXaiKey, memoryWorld, xaiFetch } from "../../src/xai/testing";

const ADMIN = "xai-token-mgmt-sentinel-5c1f";
const PREFIX = "xai-issued-sentinel-";
const VAULT = "xai-vault-sentinel-2f4b";
const OLD: FakeXaiKey = { id: "key_old", name: "prod", value: VAULT };
const NEXT: FakeXaiKey = { id: "key_next", name: "prod 2", value: "xai-next-sentinel-8a3c" };
const NOW = new Date("2026-11-17T12:00:00Z");

function xai(keys: FakeXaiKey[] = [OLD], options: Partial<FakeXai> = {}) {
  const effects: string[] = [];
  const requests: { method: string; url: string; body: string }[] = [];
  const sleeps: number[] = [];
  const world = memoryWorld(keys);
  const fake: FakeXai = {
    admin: ADMIN,
    team: "team_1",
    valuePrefix: PREFIX,
    world,
    effect: (line) => void effects.push(line),
    ...options,
  };
  const served = xaiFetch(fake);
  const fetch: Fetch = (url, init) => {
    const { host, pathname, search } = new URL(url);
    requests.push({
      method: init.method,
      url: `${host}${pathname}${search}`,
      body: init.body ?? "",
    });
    return served(url, init);
  };
  const issuer = new XaiIssuer({
    admin: async () => new Secret(ADMIN),
    fetch,
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { issuer, effects, requests, sleeps, world, fake };
}

function routed(override: (url: URL, method: string) => Response | null, fake = xai().fake): Fetch {
  const served = xaiFetch(fake);
  return async (url, init) => override(new URL(url), init.method) ?? served(url, init);
}

const withFetch = (fetch: Fetch) =>
  new XaiIssuer({
    admin: async () => new Secret(ADMIN),
    fetch,
    now: () => NOW,
    sleep: async () => {},
  });

const json = (status: number, body: object = {}) => new Response(JSON.stringify(body), { status });

function expectNoSecret(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  for (const secret of [ADMIN, PREFIX, VAULT]) expect(text).not.toContain(secret);
}

describe("checkAccount", () => {
  test("asks xAI which key the vault holds, finds it in the team, and names what create copies", async () => {
    const { issuer, requests } = xai([
      { id: "key_dev", name: "dev", value: "xai-another-key-91aa" },
      { ...OLD, acls: ["api-key:model:grok-4.7", "api-key:endpoint:chat"], qpm: 100, tpm: "50000" },
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.currentId).toBe("team_1/key_old");
    expect(check.facts).toBe('team team_1 lists 2 API keys; the vault holds "prod"');
    expect(check.notes?.create).toBe(
      "with ACLs api-key:model:grok-4.7, api-key:endpoint:chat; 100 requests a minute, 50000 tokens a minute; no expiry",
    );
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET management-api.x.ai/auth/management-keys/validation",
      "GET api.x.ai/v1/api-key",
      "GET management-api.x.ai/auth/teams/team_1/api-keys?pageSize=100",
      "GET management-api.x.ai/auth/api-keys/key_old/propagation",
    ]);
    expectNoSecret(check);
  });

  test("reads every page of keys", async () => {
    const many = Array.from({ length: 4 }, (_, n) => ({
      id: `key_${n}`,
      name: `k${n}`,
      value: `xai-filler-${n}-aaaa`,
    }));
    const { issuer, requests } = xai([...many, OLD], { pageSize: 2 });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.facts).toContain("lists 5 API keys");
    expect(requests.filter((r) => r.url.includes("/teams/")).map((r) => r.url)).toEqual([
      "management-api.x.ai/auth/teams/team_1/api-keys?pageSize=100",
      "management-api.x.ai/auth/teams/team_1/api-keys?pageSize=100&paginationToken=2",
      "management-api.x.ai/auth/teams/team_1/api-keys?pageSize=100&paginationToken=4",
    ]);
  });

  test("an organization management key works for the vault key's team", async () => {
    const { issuer } = xai([{ ...OLD, team: "team_2" }], {
      scope: "organization",
      teams: ["team_1", "team_2"],
    });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.currentId).toBe("team_2/key_old");
  });

  test("a team management key from another team is refused before listing", async () => {
    const { issuer, requests } = xai([{ ...OLD, team: "team_2" }]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toBe("the management key is for team team_1");
    expect(check.reason).toBe("the vault's key is in team team_2");
    expect(requests.some((r) => r.url.includes("/teams/"))).toBe(false);
  });

  test("a member's management key that doesn't list the vault's key says to use an admin's", async () => {
    const { issuer } = xai([{ ...OLD, owner: "user_ada" }], { member: "user_bob" });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("isn't an admin of team team_1");
  });

  test("an API key in the admin item is refused, naming what it is", async () => {
    const { issuer, effects } = xai([OLD, { id: "key_x", name: "x", value: ADMIN }], {
      admin: "xai-token-mgmt-something-else",
    });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toBe("xAI answered HTTP 401 to the management key");
    expect(check.reason).toBe(
      "the admin item holds an xAI API key, not a management key, and API keys can't create or delete keys",
    );
    await expect(issuer.create("x")).rejects.toBeInstanceOf(NothingChanged);
    expect(effects).toEqual([]);
    expectNoSecret(check);
  });

  test("a management key xAI doesn't accept", async () => {
    const { issuer } = xai([OLD], { admin: "xai-token-mgmt-something-else" });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("xAI doesn't accept the management key");
    expectNoSecret(check);
  });

  test("the same key in both items is refused", async () => {
    const { issuer } = xai();
    const check = await issuer.checkAccount(null, new Secret(ADMIN));
    assert(!check.ok);
    expect(check.reason).toContain("the vault's key is the management key");
  });

  test("a management key in the vault is refused", async () => {
    const issuer = withFetch(
      routed((url) =>
        url.pathname === "/auth/management-keys/validation"
          ? json(200, { scope: "SCOPE_TEAM", scopeId: "team_1" })
          : null,
      ),
    );
    const check = await issuer.checkAccount(null, new Secret("xai-token-another-mgmt-1234"));
    assert(!check.ok);
    expect(check.facts).toBe("the vault holds a management key");
  });

  test("a vault key xAI doesn't accept is refused", async () => {
    const { issuer } = xai([]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toBe("xAI doesn't accept the vault's key");
    expect(check.fix).toContain("put the key your apps use in the vault");
  });

  test("a disabled or blocked vault key is refused", async () => {
    for (const [key, reason] of [
      [{ ...OLD, disabled: true }, "the vault's key is disabled"],
      [{ ...OLD, blocked: true }, "the vault's key is blocked"],
    ] as const) {
      const { issuer } = xai([key]);
      const check = await issuer.checkAccount(null, new Secret(VAULT));
      assert(!check.ok);
      expect(check.reason).toBe(`${reason}, and keypin won't make an active copy of it`);
    }
  });

  test("a blocked key keypin issued last time is refused on the next rotation", async () => {
    const { issuer, effects } = xai([{ ...OLD, blocked: true }]);
    const check = await issuer.checkAccount("team_1/key_old", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "the vault's key is blocked, and keypin won't make an active copy of it",
    );
    await expect(issuer.create("next")).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
  });

  test("a recorded key in another team is refused, so create can't move to that team", async () => {
    const { issuer, effects } = xai([OLD, { ...NEXT, team: "team_2" }], {
      scope: "organization",
      teams: ["team_1", "team_2"],
    });
    const check = await issuer.checkAccount("team_2/key_next", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "key key_next, the one keypin recorded for the vault's value, is another key: the vault holds key key_old of team team_1",
    );
    expect(check.fix).toBe("check .keypin/rotation.json for a change you didn't make");
    await expect(issuer.create("x")).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
  });

  test("a recorded key that isn't the vault's is refused, even in the vault key's team", async () => {
    const { issuer, effects } = xai([
      { ...OLD, acls: ["api-key:endpoint:chat"] },
      { ...NEXT, acls: ["api-key:model:*", "api-key:endpoint:*"], qpm: 900 },
    ]);
    const check = await issuer.checkAccount("team_1/key_next", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "key key_next, the one keypin recorded for the vault's value, is another key: the vault holds key key_old of team team_1",
    );
    await expect(issuer.create("x")).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
  });

  test("a key with no ACLs is refused, since its copy couldn't call anything", async () => {
    const { issuer } = xai([{ ...OLD, acls: [] }]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      'xAI shows no ACLs for key "prod", so a copy couldn\'t call any model or endpoint',
    );
  });

  test("a management key that can't list keys", async () => {
    const { issuer } = xai([OLD], { denied: ["list"] });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("can't list the API keys of team team_1");
  });

  test("a management key that can't check propagation is refused before anything is created", async () => {
    const { issuer, effects } = xai([OLD], { denied: ["propagation"] });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.fix).toContain("CheckApiKeyPropagation");
    await expect(issuer.create("x")).rejects.toBeInstanceOf(NothingChanged);
    expect(effects).toEqual([]);
  });

  test("the key keypin issued last time is found by its ID", async () => {
    const { issuer } = xai();
    const check = await issuer.checkAccount("team_1/key_old", new Secret("xai-anything-0000"));
    assert(check.ok);
    expect(check.facts).toBe('team team_1 lists 1 API key, with "prod"');
  });

  test("the key keypin issued, missing while xAI still accepts the vault's key, is refused", async () => {
    const { issuer } = xai();
    const check = await issuer.checkAccount("team_1/key_gone", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "key key_gone, the one keypin recorded for the vault's value, is another key: the vault holds key key_old of team team_1",
    );
  });

  test("the key keypin issued, missing with the vault's key refused, can't be copied", async () => {
    const { issuer } = xai([]);
    const check = await issuer.checkAccount("team_1/key_gone", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("so keypin can't copy its ACLs and rate limits");
  });

  test("an ID keypin didn't write is refused", async () => {
    const { issuer } = xai();
    for (const id of ["key_old", "team_1/key/x", "/key_old"]) {
      const check = await issuer.checkAccount(id, new Secret(VAULT));
      assert(!check.ok);
      expect(check.reason).toBe(`${id}, the key keypin issued last time, isn't an xAI key ID`);
    }
  });

  test("an expiring key whose lifetime keypin can't tell is refused", async () => {
    const issuer = withFetch(
      routed((url, method) =>
        method === "GET" && url.pathname === "/auth/teams/team_1/api-keys"
          ? json(200, {
              apiKeys: [
                {
                  apiKeyId: "key_old",
                  name: "prod",
                  aclStrings: ["api-key:model:*"],
                  createTime: "2026-02-01T00:00:00Z",
                  expireTime: "2026-01-01T00:00:00Z",
                },
              ],
            })
          : null,
      ),
    );
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("can't tell how long key");
  });

  test("a server error throws, without the management key", async () => {
    const failed = await withFetch(async () => json(500, { error: ADMIN }))
      .checkAccount(null, new Secret(VAULT))
      .catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed.message).toBe("xAI GET /auth/management-keys/validation returned HTTP 500");
    expectNoSecret(failed);
  });
});

describe("create", () => {
  test("copies the old key's ACLs, rate limits and lifetime, and waits until every cluster has the new key", async () => {
    const { issuer, requests, effects, sleeps } = xai(
      [
        {
          ...OLD,
          acls: ["api-key:endpoint:chat"],
          qps: 5,
          qpm: 100,
          tpm: "2000",
          lifetimeDays: 90,
        },
      ],
      { pendingPolls: 2 },
    );
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toBe(
      "with ACLs api-key:endpoint:chat; 5 requests a second, 100 requests a minute, 2000 tokens a minute; expiring 90 days after it's made",
    );
    const created = await issuer.create("XAI_API_KEY prod");
    expect(created.id).toBe("team_1/key_new1");
    expect(created.secret.includes(PREFIX)).toBe(true);
    expect(issuer.label(created.id)).toBe("key_new1");
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe("management-api.x.ai/auth/teams/team_1/api-keys");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      name: "XAI_API_KEY prod",
      acls: ["api-key:endpoint:chat"],
      qps: 5,
      qpm: 100,
      tpm: "2000",
      expireTime: "2027-02-15T12:00:00Z",
    });
    expect(requests.filter((r) => r.url.endsWith("/key_new1/propagation"))).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
    expect(effects).toEqual([
      "xai create key_new1 in team_1 with acls api-key:endpoint:chat, qps 5, qpm 100, tpm 2000, expires 2027-02-15T12:00:00Z",
    ]);
    expectNoSecret(created.id, check, effects);
  });

  test("a key that never reaches every cluster is deleted, and nothing changes", async () => {
    const { issuer, effects, sleeps } = xai([OLD], { pendingPolls: 1000 });
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.create("x").catch((error: unknown) => error);
    assert(failed instanceof NothingChanged);
    expect(failed.message).toBe(
      "xAI didn't report the new key key_new1 on every cluster within 60 seconds (still waiting on eu-west-1.api.x.ai), so keypin deleted it. Run this again",
    );
    expect(sleeps).toHaveLength(29);
    expect(effects).toEqual([expect.stringMatching(/^xai create key_new1/), "xai revoke key_new1"]);
  });

  test("a stuck key keypin can't delete says where to delete it", async () => {
    const { fake } = xai([OLD], { pendingPolls: 1000 });
    const issuer = withFetch(
      routed((url, method) => (method === "DELETE" ? json(500) : null), fake),
    );
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.create("x").catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed instanceof NothingChanged).toBe(false);
    expect(failed.message).toContain("and keypin couldn't delete it: delete key key_new1 at");
  });

  test("a propagation check that keeps failing with a server error stops after the same wait", async () => {
    const { fake } = xai();
    let posted = false;
    const issuer = withFetch(
      routed((url, method) => {
        if (method === "POST") posted = true;
        return posted && url.pathname.endsWith("/propagation") ? json(503) : null;
      }, fake),
    );
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.create("x").catch((error: unknown) => error);
    assert(failed instanceof NothingChanged);
    expect(failed.message).toContain("within 60 seconds, so keypin deleted it");
  });

  test("a propagation check xAI refuses stops at once and deletes the key", async () => {
    const { fake, effects } = xai();
    let posted = false;
    const issuer = withFetch(
      routed((url, method) => {
        if (method === "POST") posted = true;
        return posted && url.pathname.endsWith("/propagation") ? json(403) : null;
      }, fake),
    );
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.create("x").catch((error: unknown) => error);
    assert(failed instanceof NothingChanged);
    expect(failed.message).toContain("returned HTTP 403, so keypin deleted it");
    expect(effects.at(-1)).toBe("xai revoke key_new1");
  });

  test("a management key that can't create keys changes nothing", async () => {
    const { issuer } = xai([OLD], { denied: ["create"] });
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.create("x").catch((error: unknown) => error);
    assert(failed instanceof NothingChanged);
    expect(failed.message).toContain("can't create API keys in team team_1 (HTTP 403)");
  });

  test("a client error is NothingChanged; a server error may have made the key", async () => {
    for (const [status, type] of [
      [400, NothingChanged],
      [500, Error],
    ] as const) {
      const { issuer, fake } = xai();
      await issuer.checkAccount(null, new Secret(VAULT));
      fake.failCreate = status;
      const failed = await issuer.create("x").catch((error: unknown) => error);
      assert(failed instanceof type);
      expect(failed instanceof NothingChanged).toBe(status === 400);
      expectNoSecret(failed);
    }
  });

  test("a reply without an ID and key throws, and isn't counted as nothing created", async () => {
    const issuer = withFetch(
      routed((_url, method) => (method === "POST" ? json(200, { apiKeyId: "key_new1" }) : null)),
    );
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.create("x").catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed instanceof NothingChanged).toBe(false);
    expect(failed.message).toContain("has no apiKeyId and apiKey");
  });

  test("a lost reply isn't retried, and names the key and the team to look in", async () => {
    const { issuer, fake, effects } = xai();
    await issuer.checkAccount(null, new Secret(VAULT));
    fake.loseCreated = true;
    await expect(issuer.create("XAI_API_KEY prod")).rejects.toThrow("fetch failed");
    expect(effects).toHaveLength(1);
    expect(issuer.lostCreate("XAI_API_KEY prod")).toBe(
      'xAI may have made the key before the reply was lost. Only this run uses the name "XAI_API_KEY prod": delete a key with that name in team team_1 at https://console.x.ai/team/default/api-keys before you run this again, or the rerun leaves it live.',
    );
  });
});

describe("revoke", () => {
  const vault = new Secret(NEXT.value);

  test("deletes the retired key of the vault key's team", async () => {
    const { issuer, requests, effects } = xai([OLD, NEXT]);
    await issuer.checkAccount("team_1/key_next", vault);
    expect(await issuer.revoke("team_1/key_old", vault)).toBe("revoked");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "management-api.x.ai/auth/api-keys/key_old",
    });
    expect(effects).toEqual(["xai revoke key_old"]);
    expect(await issuer.revoke("team_1/key_old", vault)).toBe("already gone");
  });

  test("a key the team doesn't list is already gone, and nothing is deleted", async () => {
    const { issuer, requests } = xai([OLD, NEXT]);
    await issuer.checkAccount("team_1/key_next", vault);
    expect(await issuer.revoke("team_1/key_gone", vault)).toBe("already gone");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  test("refuses the key the vault holds, whatever team the ID names", async () => {
    const { issuer, effects } = xai([OLD, NEXT]);
    await issuer.checkAccount("team_1/key_next", vault);
    for (const id of ["team_1/key_next", "team_2/key_next"]) {
      const failed = await issuer.revoke(id, vault).catch((error: unknown) => error);
      assert(failed instanceof RevokeRefused);
      expect(failed.message).toBe("it's the key the vault holds");
    }
    expect(effects).toEqual([]);
  });

  test("refuses a key of another team, even with an organization management key", async () => {
    const { issuer, effects, requests } = xai(
      [OLD, NEXT, { id: "key_web", name: "web", value: "xai-web-sentinel-1d9e", team: "team_2" }],
      {
        scope: "organization",
        teams: ["team_1", "team_2"],
      },
    );
    await issuer.checkAccount("team_1/key_next", vault);
    await expect(issuer.revoke("team_2/key_web", vault)).rejects.toThrow(
      new RevokeRefused(
        "it belongs to team team_2, not to team team_1, which owns the vault's key",
      ),
    );
    expect(await issuer.revoke("team_1/key_web", vault)).toBe("already gone");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(effects).toEqual([]);
  });

  test("refuses when xAI doesn't accept the vault's key", async () => {
    const { issuer, effects } = xai([OLD, NEXT]);
    await issuer.checkAccount("team_1/key_next", vault);
    await expect(issuer.revoke("team_1/key_old", new Secret("xai-gone-0000"))).rejects.toThrow(
      new RevokeRefused("xAI doesn't accept the vault's key"),
    );
    expect(effects).toEqual([]);
  });

  test("a management key that can't delete says where to delete it", async () => {
    const { issuer } = xai([OLD, NEXT], { denied: ["delete"] });
    await issuer.checkAccount(null, new Secret(VAULT));
    await expect(issuer.revoke("team_1/key_old", vault)).rejects.toThrow(
      'can\'t delete key "prod" (HTTP 403): give it that permission at https://console.x.ai/team/default/management-keys, or delete the key at https://console.x.ai/team/default/api-keys',
    );
  });

  test("another failure throws, without the management key", async () => {
    const { fake } = xai([OLD, NEXT]);
    const issuer = withFetch(
      routed((_url, method) => (method === "DELETE" ? json(500, { error: ADMIN }) : null), fake),
    );
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.revoke("team_1/key_old", vault).catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed.message).toBe("xAI DELETE /auth/api-keys/<id> returned HTTP 500");
    expectNoSecret(failed);
  });
});

describe("has", () => {
  test("a team the management key can't list throws, without the management key", async () => {
    const { issuer, requests } = xai([OLD, { ...NEXT, team: "team_2" }]);
    const failed = await issuer.has("team_2/key_next").catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed.message).toBe("xAI GET /auth/teams/<team_id>/api-keys returned HTTP 403");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expectNoSecret(failed);
  });
});

describe("the issuer table", () => {
  const parse = (fields: string) =>
    readSecretspec(
      `
[project]
name = "app"
revision = "1.0"

[profiles.prod]
XAI_API_KEY = { description = "a key", providers = ["onepassword://my.1password.com@Private"], ref = { item = "app xai key", field = "credential" } }

[tool.keypin.prod.XAI_API_KEY]
issuer = { kind = "xai", admin = "op://Private/xai management key/credential"${fields} }
`,
      "/w/secretspec.toml",
      [],
      [xaiIssuer],
      [onePasswordVault],
    );

  test("needs only the management key", () => {
    const parsed = parse("");
    assert(parsed.ok);
    expect(parsed.map.keys[0]?.environments.prod?.issuer).toMatchObject({ kind: "xai" });
  });

  test("refuses other fields: keypin asks xAI for the team", () => {
    const parsed = parse(`, team_id = "team_1"`);
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain(`unknown field "team_id" for xai`);
  });
});
