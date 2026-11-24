import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, RevokeRefused, Secret } from "@keypin/core";
import { ElevenLabsIssuer } from "../../src/elevenlabs/index";
import {
  type FakeElevenLabs,
  type FakeElevenLabsKey,
  elevenlabsFetch,
  memoryWorld,
} from "../../src/elevenlabs/testing";

const ADMIN = "sk_admin_sentinel_5c1f";
const PREFIX = "sk_issued_sentinel_";
const VAULT = "sk_vault_sentinel_2f4b";
const PERSON = "sk_person_sentinel_8e1a";
const OLD: FakeElevenLabsKey = { account: "sa_app", keyId: "key_old", name: "prod", value: VAULT };
const NEXT: FakeElevenLabsKey = {
  account: "sa_app",
  keyId: "key_next",
  name: "prod 2",
  value: "sk_next_sentinel_8a3c",
};
const OTHER: FakeElevenLabsKey = {
  account: "sa_other",
  keyId: "key_web",
  name: "web",
  value: "sk_web_sentinel_1d9e",
};
const ACCOUNTS = [
  { id: "sa_app", name: "app" },
  { id: "sa_other", name: "other" },
];
const NOW = new Date("2026-11-17T12:00:00Z");

function elevenlabs(keys: FakeElevenLabsKey[] = [OLD], options: Partial<FakeElevenLabs> = {}) {
  const effects: string[] = [];
  const requests: { method: string; path: string; body: string }[] = [];
  const fake: FakeElevenLabs = {
    admin: ADMIN,
    valuePrefix: PREFIX,
    accounts: ACCOUNTS,
    people: [{ id: "person_ada", value: PERSON }],
    world: memoryWorld(keys),
    effect: (line) => void effects.push(line),
    now: () => NOW,
    ...options,
  };
  const served = elevenlabsFetch(fake);
  const fetch: Fetch = (url, init) => {
    requests.push({ method: init.method, path: new URL(url).pathname, body: init.body ?? "" });
    return served(url, init);
  };
  const issuer = new ElevenLabsIssuer({
    admin: async () => new Secret(ADMIN),
    fetch,
    now: () => NOW,
  });
  return { issuer, effects, requests, fake };
}

const answering =
  (status: number, body: object = {}): Fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

const withFetch = (fetch: Fetch) =>
  new ElevenLabsIssuer({ admin: async () => new Secret(ADMIN), fetch, now: () => NOW });

function expectNoSecret(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  for (const secret of [ADMIN, PREFIX, VAULT, PERSON]) expect(text).not.toContain(secret);
}

describe("checkAccount", () => {
  test("finds the vault's key by its service account, and keeps its ID", async () => {
    const { issuer } = elevenlabs([
      OLD,
      { account: "sa_other", keyId: "key_dev", name: "dev", value: "sk_another_91aa" },
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.currentId).toBe("sa_app/key_old");
    expect(check.facts).toBe(
      'the admin key lists 2 service accounts; the vault holds "prod" of service account "app"',
    );
    expect(check.notes?.create).toBe(
      'for service account "app", with the old key\'s 3 permissions, no credit limit; no expiry',
    );
    expectNoSecret(check);
  });

  test("the plan names the credit limit, IP ranges, concurrency and lifetime it copies", async () => {
    const { issuer } = elevenlabs([
      {
        ...OLD,
        characterLimit: 100_000,
        allowedIps: ["203.0.113.0/24"],
        limits: { concurrency: { limit: 4 } },
        lifetimeDays: 30,
      },
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toBe(
      "for service account \"app\", with the old key's 3 permissions, the old key's limit of 100,000 credits a month, starting unspent, 1 allowed IP range, the same concurrency limits; expiring 30 days after it's made",
    );
  });

  test("a disabled key that isn't the vault's doesn't make the match ambiguous", async () => {
    const { issuer } = elevenlabs([
      { ...OLD, keyId: "key_leaked", name: "leaked", value: "sk_leaked_0001", disabled: true },
      OLD,
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.currentId).toBe("sa_app/key_old");
  });

  test("an expired key that isn't the vault's doesn't make the match ambiguous", async () => {
    const { issuer } = elevenlabs([
      {
        ...OLD,
        keyId: "key_lapsed",
        name: "lapsed",
        value: "sk_lapsed_0001",
        expiresAt: NOW.getTime() / 1000 - 60,
      },
      OLD,
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.currentId).toBe("sa_app/key_old");
  });

  test("refuses when the vault and the admin item hold the same key, before any request", async () => {
    const { issuer, requests } = elevenlabs();
    const check = await issuer.checkAccount(null, new Secret(ADMIN));
    assert(!check.ok);
    expect(check.reason).toBe("the vault's key is the admin key keypin signs in with");
    expect(requests).toEqual([]);
    await expect(issuer.create("API_KEY")).rejects.toThrow(NothingChanged);
  });

  test("refuses a key owned by a person, since the API makes keys only for service accounts", async () => {
    const { issuer } = elevenlabs();
    const check = await issuer.checkAccount(null, new Secret(PERSON));
    assert(!check.ok);
    expect(check.reason).toContain("belongs to a person, not a service account");
    expect(check.fix).toContain("replace it once with a key from a service account");
    expectNoSecret(check);
  });

  test("refuses when a service account has two active keys, since keypin can't tell which is the vault's", async () => {
    const { issuer } = elevenlabs([
      OLD,
      { ...OLD, keyId: "key_two", name: "staging", value: "sk_second_key_77aa" },
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toContain('service account "app" has 2 active keys');
    expect(check.reason).toBe(
      'keypin can\'t tell which of service account "app"\'s keys ("prod", "staging") the vault holds',
    );
  });

  test("refuses a vault key without User read, which keypin needs to find its service account", async () => {
    const { issuer } = elevenlabs([{ ...OLD, permissions: ["text_to_speech"] }]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("has no User read permission");
    expectNoSecret(check);
  });

  test("refuses a vault key ElevenLabs doesn't accept", async () => {
    const { issuer } = elevenlabs();
    const check = await issuer.checkAccount(null, new Secret("sk_gone_key_0000"));
    assert(!check.ok);
    expect(check.facts).toContain("ElevenLabs doesn't accept the vault's key");
  });

  test("refuses a disabled key keypin issued last time", async () => {
    const { issuer } = elevenlabs([{ ...OLD, disabled: true }]);
    const check = await issuer.checkAccount("sa_app/key_old", new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toContain("disabled (exposed_publicly)");
    expect(check.reason).toBe(
      'key "prod" is disabled at ElevenLabs, and keypin won\'t make an active copy of it',
    );
  });

  test("refuses a key whose permissions ElevenLabs doesn't show", async () => {
    const { issuer } = elevenlabs([{ ...OLD, permissions: null }]);
    const check = await issuer.checkAccount("sa_app/key_old", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("doesn't show key \"prod\"'s permissions");
  });

  test("refuses a Professional Voice Clone limit, which a new key wouldn't get", async () => {
    const { issuer } = elevenlabs([{ ...OLD, limits: { pvc: { limit: 2 } } }]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("Professional Voice Clone limit");
  });

  test("refuses a credit limit that differs from the character limit it can copy", async () => {
    const { issuer } = elevenlabs([
      { ...OLD, characterLimit: 1000, limits: { credits: { limit: 500 } } },
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("a credit limit keypin can't copy");
  });

  test("refuses a key keypin issued that the workspace no longer lists", async () => {
    const { issuer } = elevenlabs();
    const check = await issuer.checkAccount("sa_app/key_gone", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("has no key key_gone, the one keypin issued last time");
  });

  test("a recorded key of another service account is refused, so create can't move to it", async () => {
    const { issuer, effects } = elevenlabs([OLD, OTHER]);
    const check = await issuer.checkAccount("sa_other/key_web", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      'key "web", the one keypin recorded for the vault\'s value, belongs to service account "other", not to service account "app", which owns the vault\'s key',
    );
    expect(check.fix).toBe("check .keypin/rotation.json for a change you didn't make");
    await expect(issuer.create("API_KEY")).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
  });

  test("an admin key ElevenLabs doesn't accept says so", async () => {
    const issuer = withFetch(
      answering(401, { detail: { code: "invalid_api_key", status: "invalid_api_key" } }),
    );
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("doesn't accept the admin key");
  });

  test("an admin key without service account access says what it needs", async () => {
    const { issuer } = elevenlabs([OLD], { adminLacksPermission: true });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "the admin key can't list service accounts: only a workspace admin's key with access to service accounts can",
    );
    expectNoSecret(check);
  });

  test("a 403 for the vault's key names the IP allowlist, not a bad value", async () => {
    const { fake } = elevenlabs();
    const served = elevenlabsFetch(fake);
    const issuer = withFetch(async (url, init) =>
      new URL(url).pathname === "/v1/user"
        ? new Response(JSON.stringify({ detail: { status: "ip_not_allowed" } }), { status: 403 })
        : served(url, init),
    );
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("the key's IP allowlist may not include this address");
    expect(check.reason).not.toContain("the item holds another value");
    expectNoSecret(check);
  });

  test("a 403 for the admin key names the IP allowlist", async () => {
    const issuer = withFetch(answering(403, { detail: { status: "ip_not_allowed" } }));
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("its IP allowlist may not include this address");
    expectNoSecret(check);
  });

  test("a server error listing service accounts throws without the admin key", async () => {
    const issuer = withFetch(answering(500, { detail: { code: "internal_error" } }));
    const error = await issuer.checkAccount(null, new Secret(VAULT)).catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe(
      "ElevenLabs GET /v1/service-accounts returned HTTP 500 internal_error",
    );
  });
});

describe("create", () => {
  test("makes the key for the same service account with every setting it copies", async () => {
    const { issuer, effects, requests } = elevenlabs([
      {
        ...OLD,
        permissions: ["text_to_speech", "user_read"],
        characterLimit: 5000,
        allowedIps: ["203.0.113.0/24"],
        thirdPartyDisable: false,
        limits: { concurrency: { limit: 4 }, music_concurrency: { limit: 1 } },
        lifetimeDays: 30,
      },
    ]);
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    const created = await issuer.create("ELEVENLABS_API_KEY keypin 2026-11-17");
    expect(created.id).toBe("sa_app/key_new1");
    const post = requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/v1/service-accounts/sa_app/api-keys");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      name: "ELEVENLABS_API_KEY keypin 2026-11-17",
      permissions: ["text_to_speech", "user_read"],
      character_limit: 5000,
      allowed_ips: ["203.0.113.0/24"],
      third_party_disable_allowed: false,
      tts_concurrency_limit: 4,
      music_concurrency_limit: 1,
      expires_at_unix: NOW.getTime() / 1000 + 30 * 86_400,
    });
    expect(effects).toHaveLength(1);
    expectNoSecret(created.id, effects[0]?.replace(PREFIX, ""));
  });

  test("a key with no optional settings sends only its name and permissions", async () => {
    const { issuer, requests } = elevenlabs();
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    await issuer.create("API_KEY");
    const post = requests.find((r) => r.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      name: "API_KEY",
      permissions: ["text_to_speech", "voices_read", "user_read"],
    });
  });

  test("a create ElevenLabs refuses changes nothing; a server error may have", async () => {
    const refused = elevenlabs([OLD]);
    assert((await refused.issuer.checkAccount(null, new Secret(VAULT))).ok);
    refused.fake.failCreate = 422;
    await expect(refused.issuer.create("API_KEY")).rejects.toThrow(NothingChanged);
    const failed = elevenlabs([OLD]);
    assert((await failed.issuer.checkAccount(null, new Secret(VAULT))).ok);
    failed.fake.failCreate = 500;
    const error = await failed.issuer.create("API_KEY").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error).not.toBeInstanceOf(NothingChanged);
    expectNoSecret(error);
  });

  test("a 403 on create says the admin key needs service account access", async () => {
    const { issuer, fake } = elevenlabs();
    assert((await issuer.checkAccount(null, new Secret(VAULT))).ok);
    fake.failCreate = 403;
    await expect(issuer.create("API_KEY")).rejects.toThrow(
      "the admin key can't create service account keys (HTTP 403)",
    );
  });

  test("a lost create names the key to delete", () => {
    const { issuer } = elevenlabs();
    expect(issuer.lostCreate("API_KEY 14:02:11")).toContain('the name "API_KEY 14:02:11"');
  });
});

describe("revoke", () => {
  const vault = new Secret(NEXT.value);

  test("deletes the retired key of the vault key's service account and shows it by name", async () => {
    const { issuer, effects } = elevenlabs([OLD, NEXT]);
    assert((await issuer.checkAccount("sa_app/key_next", vault)).ok);
    expect(issuer.label("sa_app/key_old")).toBe('"prod"');
    expect(await issuer.revoke("sa_app/key_old", vault)).toBe("revoked");
    expect(effects).toEqual(["elevenlabs revoke sa_app/key_old"]);
    expect(await issuer.revoke("sa_app/key_old", vault)).toBe("already gone");
  });

  test("an ID that isn't account/key, or a key the account doesn't list, is already gone", async () => {
    const { issuer, requests } = elevenlabs([OLD, NEXT]);
    assert((await issuer.checkAccount("sa_app/key_next", vault)).ok);
    expect(await issuer.revoke("key_old", vault)).toBe("already gone");
    expect(await issuer.revoke("sa_app/key_gone", vault)).toBe("already gone");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  test("refuses the service account's only active key, since it's the vault's", async () => {
    const { issuer, effects } = elevenlabs([{ ...OLD, disabled: true }, NEXT]);
    assert((await issuer.checkAccount("sa_app/key_next", vault)).ok);
    await expect(issuer.revoke("sa_app/key_next", vault)).rejects.toThrow(
      new RevokeRefused(
        "it's the only active key of service account \"app\", so it's the key the vault holds",
      ),
    );
    expect(effects).toEqual([]);
  });

  test("refuses a key of another service account, even one that's gone", async () => {
    const { issuer, effects } = elevenlabs([OLD, NEXT, OTHER]);
    assert((await issuer.checkAccount("sa_app/key_next", vault)).ok);
    await expect(issuer.revoke("sa_other/key_web", vault)).rejects.toThrow(
      new RevokeRefused(
        'it belongs to service account "other", not to service account "app", which owns the vault\'s key',
      ),
    );
    await expect(issuer.revoke("sa_missing/key_old", vault)).rejects.toThrow(
      "it belongs to service account sa_missing, not to",
    );
    expect(effects).toEqual([]);
  });

  test("refuses when ElevenLabs won't say which service account the vault's key belongs to", async () => {
    const { issuer, effects } = elevenlabs([OLD, { ...NEXT, permissions: ["text_to_speech"] }]);
    assert((await issuer.checkAccount("sa_app/key_old", new Secret(VAULT))).ok);
    await expect(issuer.revoke("sa_app/key_old", vault)).rejects.toThrow(
      new RevokeRefused("keypin can't tell which service account the vault's key belongs to"),
    );
    expect(effects).toEqual([]);
  });
});
