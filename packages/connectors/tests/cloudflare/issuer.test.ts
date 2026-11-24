import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, readSecretspec, RevokeRefused, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { CloudflareIssuer, cloudflareIssuer } from "../../src/cloudflare/index";
import {
  type FakeToken,
  type FakeTokens,
  memoryTokens,
  tokensFetch,
} from "../../src/cloudflare/testing";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ADMIN = "cfut_adminsentineladminsentinel00000000_5c1f";
const PREFIX = "cfut_issuedsentinel_";
const VAULT = "cfut_vaultsentinelvaultsentinel000000000_2f4b";
const OLD_ID = "a".repeat(32);
const NOW = new Date("2026-11-17T12:00:00Z");
const POLICY = {
  id: "f267e341f3dd4697bd3b9f71dd96247f",
  effect: "allow",
  resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
  permission_groups: [
    { id: "e086da7e2179491d91ee5f35b3ca210a", name: "Workers Scripts Write", meta: {} },
  ],
};
const OLD: FakeToken = { id: OLD_ID, name: "deploy", value: VAULT, policies: [POLICY] };

function cloudflare(
  tokens: FakeToken[] = [OLD],
  options: Partial<FakeTokens> = {},
  accountId?: string,
) {
  const effects: string[] = [];
  const requests: { method: string; path: string; body: string; auth: string }[] = [];
  const world = memoryTokens(tokens);
  const fake: FakeTokens = {
    admin: ADMIN,
    valuePrefix: PREFIX,
    world,
    effect: (line) => void effects.push(line),
    ...(accountId === undefined ? {} : { account: accountId }),
    ...options,
  };
  const served = tokensFetch(fake);
  const fetch: Fetch = (url, init) => {
    requests.push({
      method: init.method,
      path: new URL(url).pathname,
      body: init.body ?? "",
      auth: init.headers.Authorization ?? "",
    });
    return served(url, init);
  };
  const issuer = new CloudflareIssuer({
    admin: async () => new Secret(ADMIN),
    fetch,
    now: () => NOW,
    ...(accountId === undefined ? {} : { accountId }),
  });
  return { issuer, effects, requests, world, fake };
}

function answering(replies: Record<string, { status: number; body?: object }>): Fetch {
  return async (url, init) => {
    const path = new URL(url).pathname.replace("/client/v4", "");
    const found = replies[`${init.method} ${path}`] ?? { status: 404 };
    return new Response(JSON.stringify(found.body ?? { success: false, errors: [] }), {
      status: found.status,
    });
  };
}

const withFetch = (fetch: Fetch, accountId?: string) =>
  new CloudflareIssuer({
    admin: async () => new Secret(ADMIN),
    fetch,
    now: () => NOW,
    ...(accountId === undefined ? {} : { accountId }),
  });

function expectNoSecret(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  for (const secret of [ADMIN, PREFIX, VAULT]) expect(text).not.toContain(secret);
}

describe("checkAccount", () => {
  test("finds the vault's token with verify, then reads it with the admin token", async () => {
    const { issuer, requests } = cloudflare();
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.currentId).toBe(OLD_ID);
    expect(check.facts).toBe('the vault holds user API token "deploy", with 1 policy');
    expect(check.notes?.create).toBe(
      "with the old token's 1 policy (Workers Scripts Write); no expiry",
    );
    expect(requests.map((r) => [r.method, r.path, r.auth])).toEqual([
      ["GET", "/client/v4/user/tokens/verify", `Bearer ${VAULT}`],
      ["GET", `/client/v4/user/tokens/${OLD_ID}`, `Bearer ${ADMIN}`],
    ]);
    expect(issuer.label(OLD_ID)).toBe('"deploy"');
    expectNoSecret(check);
  });

  test("an account API token is verified and read under the account", async () => {
    const value = "cfat_vaultsentinelvaultsentinel000000000_2f4b";
    const { issuer, requests } = cloudflare(
      [{ ...OLD, value }],
      { valuePrefix: "cfat_issuedsentinel_" },
      ACCOUNT,
    );
    const check = await issuer.checkAccount(null, new Secret(value));
    assert(check.ok);
    expect(check.facts).toBe('the vault holds account API token "deploy", with 1 policy');
    expect(requests.map((r) => r.path)).toEqual([
      `/client/v4/accounts/${ACCOUNT}/tokens/verify`,
      `/client/v4/accounts/${ACCOUNT}/tokens/${OLD_ID}`,
    ]);
    expect(issuer.dashboard()).toBe("https://dash.cloudflare.com/?to=/:account/api-tokens");
  });

  test("a token keypin issued is matched with verify, then read by its ID", async () => {
    const { issuer, requests } = cloudflare();
    const check = await issuer.checkAccount(OLD_ID, new Secret(VAULT));
    assert(check.ok);
    expect(check.currentId).toBeUndefined();
    expect(check.facts).toBe('keypin issued user API token "deploy", with 1 policy');
    expect(requests.map((r) => r.path)).toEqual([
      "/client/v4/user/tokens/verify",
      `/client/v4/user/tokens/${OLD_ID}`,
    ]);
  });

  test.each([
    ["cfk_globalkeyglobalkeyglobalkey0000000000_1a2b", "not the Global API Key", undefined],
    ["cfoat_wranglerloginwranglerlogin00000000_1a2b", "wrangler refreshes", undefined],
    ["cfat_accounttokenaccounttoken00000000000_1a2b", "the issuer has no account_id", undefined],
    ["cfut_usertokenusertokenusertoken00000000_1a2b", "remove account_id", ACCOUNT],
  ])("refuses %s before any request", async (value, says, accountId) => {
    const { issuer, requests } = cloudflare([], {}, accountId);
    const check = await issuer.checkAccount(null, new Secret(value));
    assert(!check.ok);
    expect(`${check.reason} ${check.fix}`).toContain(says);
    expect(requests).toEqual([]);
    expect(check.reason).not.toContain(value);
  });

  test.each([
    ["cfk_globalkeyglobalkeyglobalkey0000000000_1a2b", "Global API Key"],
    ["cfoat_wranglerloginwranglerlogin00000000_1a2b", "wrangler login token"],
  ])("refuses an admin item holding %s before any request", async (admin, kind) => {
    const requests: string[] = [];
    const issuer = new CloudflareIssuer({
      admin: async () => new Secret(admin),
      fetch: async (url) => {
        requests.push(url);
        return new Response("{}", { status: 500 });
      },
    });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(`keypin creates tokens with an API token, not a ${kind}`);
    expect(check.fix).toContain("Create additional tokens");
    expect(requests).toEqual([]);
    expect(JSON.stringify(check)).not.toContain(admin);
  });

  test("refuses when the admin item holds the token it would rotate", async () => {
    const { issuer, requests } = cloudflare([{ ...OLD, value: ADMIN }]);
    const check = await issuer.checkAccount(null, new Secret(ADMIN));
    assert(!check.ok);
    expect(check.reason).toContain("the admin token is the token keypin would rotate");
    expect(requests).toEqual([]);
    expectNoSecret(check);
  });

  test("a vault token Cloudflare doesn't accept says which kind keypin looked for", async () => {
    const { issuer } = cloudflare([]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "Cloudflare doesn't accept the vault's token as a user API token: it was deleted or expired, it's an account API token, or the item holds another value",
    );
    expect(check.fix).toContain("add account_id to the issuer");
    await expect(issuer.create("API_TOKEN")).rejects.toThrow("checkAccount");
  });

  test("an account issuer that can't verify the vault's token names the account", async () => {
    const value = "cfat_vaultsentinelvaultsentinel000000000_2f4b";
    const { issuer } = cloudflare([], {}, ACCOUNT);
    const check = await issuer.checkAccount(null, new Secret(value));
    assert(!check.ok);
    expect(check.reason).toContain(`as an account API token of account ${ACCOUNT}`);
    expect(check.fix).toBe(
      "check account_id in secretspec.toml, and put the token your apps use in the vault",
    );
  });

  test.each([
    [401, "Cloudflare doesn't accept the admin token", "Create additional tokens"],
    [403, "the admin token can't read its user's API tokens", "Create additional tokens"],
    [404, "the vault's token belongs to another Cloudflare user", "same user"],
  ])("HTTP %i reading the token is refused", async (status, reason, fix) => {
    const issuer = withFetch(
      answering({
        "GET /user/tokens/verify": { status: 200, body: { result: { id: OLD_ID } } },
        [`GET /user/tokens/${OLD_ID}`]: { status },
      }),
    );
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toBe(`Cloudflare answered HTTP ${status}`);
    expect(check.reason).toContain(reason);
    expect(check.fix).toContain(fix);
  });

  test("an account issuer that can't see the token suggests a Super Administrator", async () => {
    const issuer = withFetch(
      answering({
        [`GET /accounts/${ACCOUNT}/tokens/verify`]: {
          status: 200,
          body: { result: { id: OLD_ID } },
        },
      }),
      ACCOUNT,
    );
    const check = await issuer.checkAccount(
      null,
      new Secret("cfat_x0000000000000000000000000000000000_1a2b"),
    );
    assert(!check.ok);
    expect(check.reason).toContain("isn't a Super Administrator");
    expect(check.fix).toContain("check account_id");
  });

  test("an admin token without Account API Tokens Edit is told what to get", async () => {
    const issuer = withFetch(
      answering({
        [`GET /accounts/${ACCOUNT}/tokens/verify`]: {
          status: 200,
          body: { result: { id: OLD_ID } },
        },
        [`GET /accounts/${ACCOUNT}/tokens/${OLD_ID}`]: { status: 403 },
      }),
      ACCOUNT,
    );
    const check = await issuer.checkAccount(
      null,
      new Secret("cfat_x0000000000000000000000000000000000_1a2b"),
    );
    assert(!check.ok);
    expect(check.reason).toBe(`the admin token can't read account ${ACCOUNT}'s API tokens`);
    expect(check.fix).toContain(`Account API Tokens Edit on account ${ACCOUNT}`);
  });

  test("a recorded token that isn't the vault's is refused, and nothing is copied", async () => {
    const { issuer, effects } = cloudflare([
      OLD,
      { id: "b".repeat(32), name: "admin", value: "cfut_other", policies: [POLICY] },
    ]);
    const check = await issuer.checkAccount("b".repeat(32), new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      `token ${"b".repeat(32)}, the one keypin recorded for the vault's value, is another token`,
    );
    expect(check.fix).toBe("check .keypin/rotation.json for a change you didn't make");
    await expect(issuer.create("API_TOKEN")).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
  });

  test("a disabled token isn't copied", async () => {
    const { issuer } = cloudflare([{ ...OLD, status: "disabled" }]);
    const check = await issuer.checkAccount(OLD_ID, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain('token "deploy" is disabled');
  });

  test("a token whose lifetime keypin can't work out is refused", async () => {
    const { issuer } = cloudflare([
      { ...OLD, expires_on: "2026-01-01T00:00:00Z", issued_on: "soon" },
    ]);
    const check = await issuer.checkAccount(OLD_ID, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("can't tell how long");
  });

  test("a token with no policy keypin can read stops the check", async () => {
    const issuer = withFetch(
      answering({
        "GET /user/tokens/verify": { status: 200, body: { result: { id: OLD_ID } } },
        [`GET /user/tokens/${OLD_ID}`]: {
          status: 200,
          body: { result: { id: OLD_ID, policies: [{ effect: "allow" }] } },
        },
      }),
    );
    await expect(issuer.checkAccount(OLD_ID, new Secret(VAULT))).rejects.toThrow(
      "has no policies keypin can read",
    );
  });

  test("an unexpected verify answer is an error, not a refusal", async () => {
    const issuer = withFetch(answering({ "GET /user/tokens/verify": { status: 500 } }));
    await expect(issuer.checkAccount(null, new Secret(VAULT))).rejects.toThrow(
      "Cloudflare GET /user/tokens/verify with the vault's token returned HTTP 500",
    );
  });
});

describe("create", () => {
  test("copies the old token's policies and IP filter, and keeps its lifetime", async () => {
    const condition = { "request.ip": { in: ["199.27.128.0/21"], not_in: ["199.27.128.1/32"] } };
    const old: FakeToken = {
      ...OLD,
      condition,
      not_before: "2026-01-01T00:00:00Z",
      expires_on: "2026-04-01T00:00:00Z",
    };
    const { issuer, requests, world } = cloudflare([old]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toBe(
      "with the old token's 1 policy (Workers Scripts Write) and IP filter; expiring 90 days after it starts",
    );
    const created = await issuer.create("CLOUDFLARE_API_TOKEN prod");
    const sent: unknown = JSON.parse(requests.at(-1)?.body ?? "");
    expect(sent).toEqual({
      name: "CLOUDFLARE_API_TOKEN prod",
      policies: [
        {
          effect: "allow",
          resources: POLICY.resources,
          permission_groups: [{ id: "e086da7e2179491d91ee5f35b3ca210a" }],
        },
      ],
      condition,
      expires_on: "2027-02-15T12:00:00Z",
    });
    expect(sent).not.toHaveProperty("not_before");
    expect(created.secret.includes(PREFIX)).toBe(true);
    expect(world.load().tokens.map((t) => t.id)).toEqual([OLD_ID, created.id]);
  });

  test("a token without not_before starts its lifetime when it was issued", async () => {
    const old: FakeToken = {
      ...OLD,
      issued_on: "2026-11-01T12:00:00Z",
      expires_on: "2026-12-01T12:00:00Z",
    };
    const { issuer, requests } = cloudflare([old]);
    await issuer.checkAccount(null, new Secret(VAULT));
    await issuer.create("API_TOKEN");
    const sent: unknown = JSON.parse(requests.at(-1)?.body ?? "");
    expect(sent).toMatchObject({ expires_on: "2026-12-17T12:00:00Z" });
    expect(sent).not.toHaveProperty("not_before");
  });

  test("a start date still ahead keeps the new token waiting for it", async () => {
    const old: FakeToken = {
      ...OLD,
      not_before: "2027-01-01T00:00:00Z",
      expires_on: "2027-01-31T00:00:00Z",
    };
    const { issuer, requests } = cloudflare([old]);
    await issuer.checkAccount(null, new Secret(VAULT));
    await issuer.create("API_TOKEN");
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toMatchObject({
      not_before: "2027-01-01T00:00:00Z",
      expires_on: "2027-01-31T00:00:00Z",
    });
  });

  test("an account issuer creates the token under the account", async () => {
    const value = "cfat_vaultsentinelvaultsentinel000000000_2f4b";
    const { issuer, requests, effects } = cloudflare([{ ...OLD, value }], {}, ACCOUNT);
    await issuer.checkAccount(null, new Secret(value));
    await issuer.create("API_TOKEN");
    expect(requests.at(-1)?.path).toBe(`/client/v4/accounts/${ACCOUNT}/tokens`);
    expect(effects).toHaveLength(1);
  });

  test("a long name is cut to Cloudflare's 120 characters, keeping its start, the time and the run's tag", async () => {
    const { issuer, requests } = cloudflare();
    await issuer.checkAccount(null, new Secret(VAULT));
    const name = `web ${"A".repeat(120)} prod 2026-11-17T09:30Z 3f9a2c`;
    await issuer.create(name);
    const body: unknown = JSON.parse(requests.at(-1)?.body ?? "");
    assert(
      typeof body === "object" && body !== null && "name" in body && typeof body.name === "string",
    );
    const sent = body.name;
    expect(sent).toHaveLength(120);
    expect(sent).toBe(`web ${"A".repeat(90)}… 2026-11-17T09:30Z 3f9a2c`);
    expect(issuer.lostCreate(name)).toContain(`"${sent}"`);
  });

  test("the lifetime stays the same over successive rotations", async () => {
    const { issuer, fake } = cloudflare([
      { ...OLD, not_before: "2026-01-01T00:00:00Z", expires_on: "2026-04-01T00:00:00Z" },
    ]);
    await issuer.checkAccount(null, new Secret(VAULT));
    const first = await issuer.create("API_TOKEN 1");
    const next = new CloudflareIssuer({
      admin: async () => new Secret(ADMIN),
      fetch: tokensFetch(fake),
      now: () => NOW,
    });
    const check = await next.checkAccount(first.id, first.secret);
    assert(check.ok);
    expect(check.notes?.create).toBe(
      "with the old token's 1 policy (e086da7e2179491d91ee5f35b3ca210a); expiring 90 days after it starts",
    );
  });

  test.each([401, 403])(
    "HTTP %i says the admin token can't create tokens, and nothing changed",
    async (status) => {
      const { issuer } = cloudflare([OLD], { failCreate: status });
      await issuer.checkAccount(null, new Secret(VAULT));
      const failed = await issuer.create("API_TOKEN").catch((e: unknown) => e);
      assert(failed instanceof NothingChanged);
      expect(failed.message).toContain("the admin token can't create Cloudflare tokens");
      expect(failed.message).toContain("Create additional tokens");
      expectNoSecret(failed);
    },
  );

  test("a 400 is NothingChanged, a 500 is an Error, and neither leaks the admin token", async () => {
    for (const [status, type] of [
      [400, NothingChanged],
      [500, Error],
    ] as const) {
      const { issuer } = cloudflare([OLD], { failCreate: status });
      await issuer.checkAccount(null, new Secret(VAULT));
      const failed = await issuer.create("API_TOKEN").catch((e: unknown) => e);
      assert(failed instanceof type);
      expect(failed instanceof NothingChanged).toBe(status === 400);
      expect(String(failed)).toContain(`Cloudflare POST /user/tokens returned HTTP ${status}`);
      expectNoSecret(failed);
    }
  });

  test("a reply without the value is an error", async () => {
    const broken = withFetch(async (url, init) =>
      init.method === "POST"
        ? new Response(JSON.stringify({ success: true, result: { id: "c".repeat(32) } }))
        : tokensFetch({
            admin: ADMIN,
            valuePrefix: PREFIX,
            world: memoryTokens([OLD]),
            effect: () => undefined,
          })(url, init),
    );
    await broken.checkAccount(null, new Secret(VAULT));
    await expect(broken.create("API_TOKEN")).rejects.toThrow("has no token id and value");
  });

  test("lostCreate names the token and where to delete it", () => {
    const { issuer } = cloudflare();
    expect(issuer.lostCreate("API_TOKEN prod")).toBe(
      'Cloudflare may have made the token before the reply was lost. Only this run uses the name "API_TOKEN prod": delete a token with that name at https://dash.cloudflare.com/profile/api-tokens before you run this again, or the rerun leaves it live.',
    );
  });
});

describe("revoke", () => {
  const NEW_ID = "b".repeat(32);
  const NEXT = "cfut_nextsentinelnextsentinel0000000000_8a2d";
  const NEW: FakeToken = { id: NEW_ID, name: "deploy 2", value: NEXT, policies: [POLICY] };
  const deletes = (requests: { method: string }[]) =>
    requests.filter((request) => request.method === "DELETE");

  test("deletes the old token, never rolls it", async () => {
    const { issuer, requests, effects } = cloudflare([OLD, NEW]);
    assert((await issuer.checkAccount(NEW_ID, new Secret(NEXT))).ok);
    expect(await issuer.revoke(OLD_ID, new Secret(NEXT))).toBe("revoked");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/client/v4/user/tokens/${OLD_ID}`,
    });
    expect(requests.some((r) => r.path.endsWith("/value"))).toBe(false);
    expect(effects).toEqual([`cloudflare delete token ${OLD_ID}`]);
  });

  const replies = (deleted: number) =>
    answering({
      "GET /user/tokens/verify": { status: 200, body: { result: { id: NEW_ID } } },
      [`GET /user/tokens/${NEW_ID}`]: {
        status: 200,
        body: { result: { id: NEW_ID, name: "deploy 2", policies: [POLICY] } },
      },
      [`GET /user/tokens/${OLD_ID}`]: {
        status: 200,
        body: { result: { id: OLD_ID, name: "deploy", policies: [POLICY] } },
      },
      [`DELETE /user/tokens/${OLD_ID}`]: { status: deleted },
    });

  test("a 403 names the token and where to delete it", async () => {
    const issuer = withFetch(replies(403));
    await issuer.checkAccount(null, new Secret(NEXT));
    await expect(issuer.revoke(OLD_ID, new Secret(NEXT))).rejects.toThrow(
      `the admin token can't delete token ${OLD_ID}`,
    );
  });

  test("a 500 is an error", async () => {
    const issuer = withFetch(replies(500));
    await issuer.checkAccount(NEW_ID, new Secret(NEXT));
    await expect(issuer.revoke(OLD_ID, new Secret(NEXT))).rejects.toThrow(
      "Cloudflare DELETE /user/tokens/<id> returned HTTP 500",
    );
  });

  test("refuses the token the vault holds, and deletes nothing", async () => {
    const { issuer, requests, effects } = cloudflare();
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    const failed = await issuer.revoke(OLD_ID, new Secret(VAULT)).catch((e: unknown) => e);
    assert(failed instanceof RevokeRefused);
    expect(failed.message).toBe("it's the token the vault holds");
    expect(deletes(requests)).toEqual([]);
    expect(effects).toEqual([]);
  });

  test("refuses the admin token, and deletes nothing", async () => {
    const ADMIN_ID = "ad".repeat(16);
    const { issuer, requests, effects } = cloudflare([
      OLD,
      { id: ADMIN_ID, name: "keypin admin", value: ADMIN, policies: [POLICY] },
    ]);
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    const failed = await issuer.revoke(ADMIN_ID, new Secret(VAULT)).catch((e: unknown) => e);
    assert(failed instanceof RevokeRefused);
    expect(failed.message).toBe("it's the admin token keypin signs in with");
    expect(deletes(requests)).toEqual([]);
    expect(effects).toEqual([]);
  });

  test("a token the admin token can't see is already gone, with no delete", async () => {
    const { issuer, requests } = cloudflare();
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    expect(await issuer.revoke(NEW_ID, new Secret(VAULT))).toBe("already gone");
    expect(deletes(requests)).toEqual([]);
  });

  test("has reads the token without checkAccount, and a Cloudflare error is an error", async () => {
    const { issuer } = cloudflare();
    expect(await issuer.has(OLD_ID)).toBe(true);
    expect(await issuer.has(NEW_ID)).toBe(false);
    const failing = withFetch(answering({ [`GET /user/tokens/${OLD_ID}`]: { status: 403 } }));
    const failed = await failing.has(OLD_ID).catch((e: unknown) => e);
    assert(failed instanceof Error);
    expect(failed.message).toBe("Cloudflare GET /user/tokens/<id> returned HTTP 403");
    expectNoSecret(failed);
  });
});

describe("the issuer table", () => {
  const map = (fields: string) => `
[project]
name = "app"
revision = "1.0"

[profiles.prod]
CLOUDFLARE_API_TOKEN = { description = "a key", providers = ["onepassword://my.1password.com@Private"], ref = { item = "deploy token", field = "credential" } }

[tool.keypin.prod.CLOUDFLARE_API_TOKEN]
issuer = { kind = "cloudflare", admin = "op://Private/cloudflare token maker/credential"${fields} }
`;
  const parse = (fields: string) =>
    readSecretspec(map(fields), "/w/secretspec.toml", [], [cloudflareIssuer], [onePasswordVault]);

  test("reads a user token issuer, and account_id for an account token issuer", () => {
    const user = parse("");
    assert(user.ok);
    const spec = user.map.keys[0]?.environments.prod?.issuer;
    expect(spec).toMatchObject({ kind: "cloudflare" });
    expect(spec).not.toHaveProperty("accountId");
    const account = parse(`, account_id = "${ACCOUNT}"`);
    assert(account.ok);
    expect(account.map.keys[0]?.environments.prod?.issuer).toMatchObject({
      kind: "cloudflare",
      accountId: ACCOUNT,
    });
  });

  test("account_id is 32 hex characters, and other fields are refused", () => {
    for (const [fields, error] of [
      [`, account_id = "acme"`, `field "account_id" must be a Cloudflare account ID`],
      [`, zone = "x"`, `unknown field "zone" for cloudflare`],
    ] as const) {
      const parsed = parse(fields);
      assert(!parsed.ok);
      expect(parsed.errors.join("\n")).toContain(error);
    }
  });
});

describe("what a rotation depends on", () => {
  test("checkAdmin reads the admin token's own expiry with verify, and nothing else", async () => {
    const { issuer, requests } = cloudflare([OLD], { adminExpires: "2026-12-01T00:00:00Z" });
    expect(await issuer.checkAdmin()).toEqual({
      credential: "the Cloudflare admin token",
      at: "2026-12-01T00:00:00Z",
      renew:
        'give it a later expiry at https://dash.cloudflare.com/profile/api-tokens, or put a token made with the "Create additional tokens" template in the admin item; create one at https://dash.cloudflare.com/profile/api-tokens',
    });
    expect(requests.map((r) => [r.method, r.path, r.auth])).toEqual([
      ["GET", "/client/v4/user/tokens/verify", `Bearer ${ADMIN}`],
    ]);
  });

  test("an admin token without an expiry has none, and one Cloudflare refuses fails", async () => {
    expect(await cloudflare().issuer.checkAdmin()).toBeNull();
    const refused = withFetch(answering({}), ACCOUNT).checkAdmin();
    await expect(refused).rejects.toThrow(
      `Cloudflare doesn't accept the admin token (Cloudflare GET /accounts/${ACCOUNT}/tokens/verify returned HTTP 404`,
    );
    await expect(refused).rejects.toThrow("Account API Tokens Edit");
    const disabled = withFetch(
      answering({
        "GET /user/tokens/verify": {
          status: 200,
          body: { success: true, result: { id: "a".repeat(32), status: "disabled" } },
        },
      }),
    ).checkAdmin();
    await expect(disabled).rejects.toThrow("the admin token is disabled at Cloudflare");
  });

  test("checkAccount reports how many days a new token lasts", async () => {
    const lasting = {
      ...OLD,
      not_before: "2026-01-01T00:00:00Z",
      expires_on: "2026-01-31T00:00:00Z",
    };
    const check = await cloudflare([lasting]).issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.lifetimeDays).toBe(30);
    const endless = await cloudflare().issuer.checkAccount(null, new Secret(VAULT));
    assert(endless.ok);
    expect(endless.lifetimeDays).toBeUndefined();
  });

  test("Admin and token-write permissions are named in a warning; narrower ones aren't", async () => {
    const group = (id: string, name: string) => ({ id, name, meta: {} });
    const broad: FakeToken = {
      ...OLD,
      policies: [
        {
          ...POLICY,
          permission_groups: [
            group("e086da7e2179491d91ee5f35b3ca210a", "Workers Scripts Write"),
            group("1af1fa2adc104452b74a9a3364202f20", "Workers Admin"),
            group("5bc3f8b21c554832afc660159ab75fa4", "Account API Tokens Write"),
          ],
        },
      ],
    };
    const check = await cloudflare([broad]).issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toBe(
      "with the old token's 1 policy (Workers Scripts Write, Workers Admin, Account API Tokens Write); no expiry",
    );
    expect(check.warnings).toEqual([
      'the new token copies Workers Admin, Account API Tokens Write from token "deploy". If it doesn\'t need those, make a narrower token at https://dash.cloudflare.com/profile/api-tokens, publish it, check what uses it still works, then delete the old one.',
    ]);
    const narrow = await cloudflare().issuer.checkAccount(null, new Secret(VAULT));
    assert(narrow.ok);
    expect(narrow.warnings).toBeUndefined();
  });
});
