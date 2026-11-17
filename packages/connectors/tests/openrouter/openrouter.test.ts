import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, parseMap, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { OpenRouterIssuer, openrouterIssuer } from "../../src/openrouter/index";
import {
  type FakeOpenRouter,
  type FakeOpenRouterKey,
  memoryWorld,
  openrouterFetch,
} from "../../src/openrouter/testing";

const ADMIN = "sk-or-v1-mgmt-sentinel-5c1f";
const PREFIX = "sk-or-v1-issued-sentinel-";
const VAULT = "sk-or-v1-vault-sentinel-2f4b";
const OLD: FakeOpenRouterKey = { hash: "hash_old", name: "prod", value: VAULT };
const NOW = new Date("2026-11-17T12:00:00Z");

function openrouter(keys: FakeOpenRouterKey[] = [OLD], options: Partial<FakeOpenRouter> = {}) {
  const effects: string[] = [];
  const requests: { method: string; path: string; body: string }[] = [];
  const world = memoryWorld(keys);
  const fake: FakeOpenRouter = {
    admin: ADMIN,
    valuePrefix: PREFIX,
    world,
    effect: (line) => void effects.push(line),
    ...options,
  };
  const served = openrouterFetch(fake);
  const fetch: Fetch = (url, init) => {
    const { pathname, search } = new URL(url);
    requests.push({ method: init.method, path: `${pathname}${search}`, body: init.body ?? "" });
    return served(url, init);
  };
  const issuer = new OpenRouterIssuer({
    admin: async () => new Secret(ADMIN),
    fetch,
    now: () => NOW,
  });
  return { issuer, effects, requests, world, fake };
}

const answering =
  (
    status: number,
    body: object = {},
    vault: object = { data: { label: "sk-or-v1-vau...f4b" } },
  ): Fetch =>
  async (url) =>
    new URL(url).pathname === "/api/v1/key"
      ? new Response(JSON.stringify(vault), { status: 200 })
      : new Response(JSON.stringify(body), { status });

const withFetch = (fetch: Fetch) =>
  new OpenRouterIssuer({ admin: async () => new Secret(ADMIN), fetch, now: () => NOW });

function expectNoSecret(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  for (const secret of [ADMIN, PREFIX, VAULT]) expect(text).not.toContain(secret);
}

describe("checkAccount", () => {
  test("finds the vault's key by the label GET /key shows, and keeps its hash", async () => {
    const { issuer } = openrouter([
      { hash: "hash_dev", name: "dev", value: "sk-or-v1-another-key-91aa" },
      OLD,
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.currentId).toBe("hash_old");
    expect(check.facts).toBe('the management key lists 2 API keys; the vault holds "prod"');
    expect(check.notes?.create).toBe("with no credit limit; no expiry, in the same workspace");
    expectNoSecret(check);
  });

  test("the plan names the limit, its reset and BYOK it copies", async () => {
    const { issuer } = openrouter([
      { ...OLD, limit: 50, limitReset: "monthly", includeByok: true },
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toBe(
      "with the old key's $50 limit, reset monthly, counting BYOK usage; no expiry, in the same workspace",
    );
  });

  test("a limit that never resets says the new key starts unspent, and moves no credit", async () => {
    const { issuer } = openrouter([{ ...OLD, limit: 20, usage: 7.5 }]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toBe(
      "with the old key's $20 limit, which never resets, starting at $0 spent (the old key has $12.50 left); no expiry, in the same workspace",
    );
  });

  test("an expiring key's lifetime goes on the plan", async () => {
    const { issuer } = openrouter([{ ...OLD, lifetimeDays: 90 }]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toContain("expiring 90 days after it's made");
  });

  test("an organization key is made for the same member", async () => {
    const { issuer } = openrouter([{ ...OLD, creatorUserId: "user_ada" }], {
      organizationId: "org_1",
    });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toContain("in the same workspace, for the same member");
  });

  test("refuses when the vault and the admin item hold the same management key", async () => {
    const { issuer, requests } = openrouter();
    const check = await issuer.checkAccount(null, new Secret(ADMIN));
    assert(!check.ok);
    expect(check.reason).toBe(
      "the vault's key is the management key keypin signs in with, and keypin rotates API keys, not management keys",
    );
    expect(requests).toEqual([]);
    expectNoSecret(check);
  });

  test("refuses a management key in the vault", async () => {
    const other = "sk-or-v1-other-mgmt-key-3a3a";
    const { issuer, requests } = openrouter([
      { hash: "hash_m", name: "ci", value: other, management: true },
    ]);
    const check = await issuer.checkAccount(null, new Secret(other));
    assert(!check.ok);
    expect(check.facts).toBe("the vault holds a management key");
    expect(check.reason).toContain("keypin rotates API keys, not management keys");
    expect(requests.map((r) => r.path)).toEqual(["/api/v1/key"]);
  });

  test("refuses two keys with the vault key's label", async () => {
    const twin = {
      hash: "hash_twin",
      name: "copy",
      value: `${VAULT.slice(0, 11)}different-key-f4b`,
    };
    const { issuer, effects } = openrouter([OLD, twin]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      '2 keys show the same label as the vault\'s key ("prod", "copy"), so keypin can\'t tell which one it is',
    );
    await expect(issuer.create("x")).rejects.toThrow("checkAccount");
    expect(effects).toEqual([]);
    expectNoSecret(check);
  });

  test("refuses a disabled key, found by its label in the list", async () => {
    const { issuer } = openrouter([{ ...OLD, disabled: true }]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toBe(
      'the management key lists 1 API key; the vault holds "prod", disabled',
    );
    expect(check.reason).toBe(
      'key "prod" is disabled at OpenRouter, and keypin won\'t make an active copy of it',
    );
  });

  test("refuses a key keypin issued that is now disabled", async () => {
    const { issuer } = openrouter([{ ...OLD, disabled: true }]);
    const check = await issuer.checkAccount("hash_old", new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toBe('keypin issued key "prod", disabled');
  });

  test("refuses a key with its own guardrail", async () => {
    const { issuer } = openrouter([OLD], { guardrailKeys: ["hash_old"] });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      'key "prod" has a guardrail budget of its own, and a new key wouldn\'t get it',
    );
  });

  test("refuses a key an enabled observability destination is limited to, before creating anything", async () => {
    const { issuer, effects } = openrouter([OLD], {
      observability: [{ enabled: true, hashes: ["hash_old"] }],
    });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      'key "prod" has an observability destination limited to it, and a new key wouldn\'t get it',
    );
    expect(effects).toEqual([]);
  });

  test("an observability destination for all keys, or a disabled one, doesn't stop the rotation", async () => {
    const { issuer } = openrouter([OLD], {
      observability: [
        { enabled: true, hashes: null },
        { enabled: false, hashes: ["hash_old"] },
        { enabled: true, hashes: ["hash_other"] },
      ],
    });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    expect(check.ok).toBe(true);
  });

  test("refuses a key a BYOK provider key is limited to", async () => {
    const { issuer } = openrouter([OLD], { byokKeys: ["hash_old"] });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      'key "prod" has a BYOK provider key limited to it, and a new key wouldn\'t get it',
    );
  });

  test("a vault key OpenRouter doesn't accept fails when keypin didn't issue it", async () => {
    const { issuer } = openrouter([]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("OpenRouter doesn't accept the vault's key");
  });

  test("a management key from another account doesn't list the vault's key", async () => {
    const { fake } = openrouter();
    const served = openrouterFetch(fake);
    const issuer = withFetch(async (url, init) =>
      new URL(url).pathname === "/api/v1/keys" && init.method === "GET"
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : served(url, init),
    );
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("the management key belongs to another account or workspace");
  });

  test("a workspace-scoped management key from another workspace is refused with what to do", async () => {
    const { issuer } = openrouter([{ ...OLD, workspaceId: "ws_other" }], {
      workspaceId: "ws_mine",
    });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "the management key can't list keys in workspace ws_other, the vault key's workspace: it's scoped to another workspace",
    );
    expect(check.fix).toContain("in that workspace or for the whole organization");
  });

  test.each([
    [401, "OpenRouter doesn't accept the management key"],
    [403, "the management key can't list keys"],
  ])("a management key refused with HTTP %i says so", async (status, reason) => {
    const check = await withFetch(answering(status)).checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain(reason);
  });

  test("an unexpected status throws without the key", async () => {
    const failed = await withFetch(answering(500))
      .checkAccount(null, new Secret(VAULT))
      .catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(String(failed)).toContain("OpenRouter GET /keys returned HTTP 500");
    expectNoSecret(failed);
  });

  test("a key keypin issued that OpenRouter deleted stops: its limit can't be copied", async () => {
    const { issuer } = openrouter([]);
    const check = await issuer.checkAccount("hash_old", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "OpenRouter has no key hash_old, the one keypin issued last time, so keypin can't copy its credit limit",
    );
    await expect(issuer.create("k")).rejects.toThrow("checkAccount");
  });

  test("a key keypin issued that the vault key no longer matches says which key to put back", async () => {
    const { issuer } = openrouter([OLD]);
    const check = await issuer.checkAccount("hash_old", new Secret("sk-or-v1-unknown-value-0000"));
    assert(!check.ok);
    expect(check.fix).toBe('put key "prod" in the vault, then run this again');
  });

  test("an issued key the management key can't see, while the vault key works, fails", async () => {
    const { issuer } = openrouter();
    const check = await issuer.checkAccount("hash_elsewhere", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "the management key doesn't list key hash_elsewhere, the one keypin issued last time",
    );
  });

  test("pages through more keys than one page holds", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      hash: `hash_${i}`,
      name: `k${i}`,
      value: `sk-or-v1-many-key-number-${i}aa`,
    }));
    const { issuer, requests } = openrouter([...many, OLD], { pageSize: 2 });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(requests.filter((r) => r.path.startsWith("/api/v1/keys?")).map((r) => r.path)).toEqual([
      "/api/v1/keys?include_disabled=true&offset=0&workspace_id=ws_default",
      "/api/v1/keys?include_disabled=true&offset=2&workspace_id=ws_default",
      "/api/v1/keys?include_disabled=true&offset=4&workspace_id=ws_default",
      "/api/v1/keys?include_disabled=true&offset=6&workspace_id=ws_default",
    ]);
  });
});

describe("create", () => {
  test("gives the new key the old key's limit, reset, BYOK, lifetime and workspace", async () => {
    const old = {
      ...OLD,
      limit: 50,
      limitReset: "weekly",
      includeByok: true,
      lifetimeDays: 30,
    } as const;
    const { issuer, requests, effects } = openrouter([old]);
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    const created = await issuer.create("OPENROUTER_API_KEY prod");
    expect(created.id).toBe("hash_new1");
    expect(created.secret.reveal().startsWith(PREFIX)).toBe(true);
    expect(JSON.parse(requests.find((r) => r.method === "POST")?.body ?? "{}")).toEqual({
      name: "OPENROUTER_API_KEY prod",
      limit: 50,
      limit_reset: "weekly",
      include_byok_in_limit: true,
      expires_at: "2026-12-17T12:00:00Z",
      workspace_id: "ws_default",
    });
    expect(effects).toEqual([
      "openrouter create hash_new1 with limit $50 weekly, byok, expires 2026-12-17T12:00:00Z, workspace ws_default",
    ]);
  });

  test("names the same member for an organization key", async () => {
    const { issuer, requests } = openrouter([{ ...OLD, creatorUserId: "user_ada" }], {
      organizationId: "org_1",
    });
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    await issuer.create("k");
    expect(JSON.parse(requests.find((r) => r.method === "POST")?.body ?? "{}")).toMatchObject({
      creator_user_id: "user_ada",
    });
  });

  test("a read-only management key can't create, and nothing changed", async () => {
    const { issuer, fake } = openrouter();
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    fake.failCreate = 403;
    const failed = await issuer.create("k").catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(NothingChanged);
    expect(String(failed)).toContain("put a read/write management key in the admin item");
    expectNoSecret(failed);
  });

  test("a server error may have made the key, so it isn't NothingChanged", async () => {
    const { issuer, fake } = openrouter();
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    fake.failCreate = 500;
    const failed = await issuer.create("k").catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(NothingChanged);
  });

  test("lostCreate names the run's key name and where to delete it", () => {
    expect(openrouter().issuer.lostCreate("OPENROUTER_API_KEY prod")).toContain(
      'Only this run uses the name "OPENROUTER_API_KEY prod": delete a key with that name at https://openrouter.ai/settings/keys',
    );
  });
});

describe("revoke", () => {
  test("deletes the key by its hash, and again is already gone", async () => {
    const { issuer, requests, effects } = openrouter();
    await issuer.checkAccount(null, new Secret(VAULT));
    expect(await issuer.revoke("hash_old")).toBe("revoked");
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/v1/keys/hash_old" });
    expect(effects).toEqual(["openrouter revoke hash_old"]);
    expect(await issuer.revoke("hash_old")).toBe("already gone");
  });

  test("the hash is one path segment", async () => {
    const { issuer, requests } = openrouter();
    await issuer.checkAccount(null, new Secret(VAULT));
    expect(await issuer.revoke("hash/../x")).toBe("already gone");
    expect(requests.at(-1)?.path).toBe("/api/v1/keys/hash%2F..%2Fx");
  });

  test("a management key that can't delete says where to delete it", async () => {
    const { fake } = openrouter();
    const served = openrouterFetch(fake);
    const issuer = withFetch(async (url, init) =>
      init.method === "DELETE" ? new Response("{}", { status: 403 }) : served(url, init),
    );
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    const failed = await issuer.revoke("hash_old").catch((e: unknown) => e);
    expect(String(failed)).toContain(
      'the management key can\'t delete key "prod" (HTTP 403): delete it at https://openrouter.ai/settings/keys',
    );
    expectNoSecret(failed);
  });
});

describe("the issuer table", () => {
  const parse = (fields: string) =>
    parseMap(
      `
[1password]
account = "my.1password.com"

[keys.OPENROUTER_API_KEY.prod]
from = "op://Private/openrouter key/credential"
issuer = { kind = "openrouter", admin = "op://Private/openrouter management key/credential"${fields} }
`,
      "/w/keypin.toml",
      [],
      [openrouterIssuer],
      [onePasswordVault],
    );

  test("needs only the management key", () => {
    const parsed = parse("");
    assert(parsed.ok);
    expect(parsed.map.keys[0]?.environments.prod?.issuer).toMatchObject({ kind: "openrouter" });
  });

  test("refuses other fields: keypin copies the limit from the old key", () => {
    const parsed = parse(`, limit = 5`);
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain(`unknown field "limit" for openrouter`);
  });
});
