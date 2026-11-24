import { assert, describe, expect, test } from "vite-plus/test";
import { NothingChanged, readSecretspec, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { SupabaseIssuer, supabaseIssuer } from "../../src/supabase/index";
import {
  type FakeSupabase,
  memoryWorld,
  type SupabaseKey,
  supabaseFetch,
} from "../../src/supabase/testing";

const REF = "abcdefghijklmnopqrst";
const ADMIN = "sbp_admin_sentinel_7d3a";
const PREFIX = "sb_secret_issued_sentinel_";
const BACKEND = "sb_secret_backendsentinel_5e2c";
const DEFAULT = "sb_secret_defaultsentinel_8b1f";
const KEYS: SupabaseKey[] = [
  { id: "key-default", name: "default", type: "secret", value: DEFAULT },
  { id: "key-backend", name: "backend", type: "secret", value: BACKEND },
  { id: "key-web", name: "default", type: "publishable", value: "sb_publishable_web_3a1d" },
  { id: "service_role", name: "service_role", type: "legacy", value: "eyJhbGciOi.legacy.jwt" },
];

function supabase(options: Partial<FakeSupabase> = {}, keys: SupabaseKey[] = KEYS) {
  const effects: string[] = [];
  const requests: string[] = [];
  const world = memoryWorld(keys);
  const fetch = supabaseFetch({
    admin: ADMIN,
    projectRef: REF,
    valuePrefix: PREFIX,
    world,
    effect: (line) => void effects.push(line),
    ...options,
  });
  const issuer = new SupabaseIssuer({
    admin: async () => new Secret(ADMIN),
    projectRef: REF,
    fetch: async (url, init) => {
      requests.push(`${init.method} ${new URL(url).pathname}${new URL(url).search}`);
      return fetch(url, init);
    },
  });
  return { issuer, effects, requests, world };
}

function expectNoSecret(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  for (const hidden of [ADMIN, PREFIX, BACKEND, DEFAULT]) expect(text).not.toContain(hidden);
}

describe("checkAccount", () => {
  test("finds the vault's key by its listed prefix and returns its ID", async () => {
    const { issuer, requests } = supabase();
    const check = await issuer.checkAccount(null, new Secret(BACKEND));
    expect(check).toEqual({
      ok: true,
      facts: `project ${REF} has 2 secret keys; the vault holds key backend`,
      currentId: "key-backend",
      notes: {
        create:
          "the new key has a new name, so an Edge Function that checks withSupabase({ auth: 'secret:<name>' }) rejects it",
        revoke: "Supabase can't undo deleting a secret key",
      },
    });
    expect(requests).toEqual([`GET /v1/projects/${REF}/api-keys`]);
    expectNoSecret(check);
  });

  test("accepts the key keypin issued last without returning an ID", async () => {
    const { issuer } = supabase();
    const check = await issuer.checkAccount("key-backend", new Secret(BACKEND));
    assert(check.ok);
    expect(check.facts).toContain("keypin issued key backend");
    expect(check).not.toHaveProperty("currentId");
  });

  test.each([
    [
      "a legacy service_role JWT",
      "eyJhbGciOiJIUzI1NiJ9.legacy.sig",
      "the vault holds a legacy service_role key, which Supabase can't replace one key at a time: turning it off turns off the anon key too",
      "https://supabase.com/docs/guides/security/rotate-leaked-api-keys",
    ],
    [
      "a publishable key",
      "sb_publishable_web_3a1d",
      "the vault holds a publishable key; keypin rotates only secret keys",
      "sb_secret_",
    ],
    [
      "another value",
      "not-a-key",
      "the vault's value isn't a Supabase secret key (sb_secret_...)",
      "put the secret key",
    ],
  ])("refuses %s in the vault before calling Supabase", async (_, value, reason, fix) => {
    const { issuer, requests } = supabase();
    const check = await issuer.checkAccount(null, new Secret(value));
    assert(!check.ok);
    expect(check.reason).toBe(reason);
    expect(check.fix).toContain(fix);
    expect(requests).toEqual([]);
    await expect(issuer.create("KEY prod")).rejects.toThrow("checkAccount hasn't passed");
  });

  test("refuses the key named default, the only one withSupabase({ auth: 'secret' }) accepts", async () => {
    const { issuer, effects } = supabase();
    const check = await issuer.checkAccount(null, new Secret(DEFAULT));
    expect(check).toEqual({
      ok: false,
      facts: `project ${REF} has 2 secret keys; the vault holds key default`,
      reason:
        "keypin won't replace the secret key named default: Edge Functions that check keys with withSupabase({ auth: 'secret' }) accept only that key, so they would reject the new one, and deleting it can't be undone",
      fix: `create a secret key with its own name for this app at https://supabase.com/dashboard/project/${REF}/settings/api-keys, put it in the vault and publish it, then rotate that one; see https://supabase.com/docs/guides/functions/auth#service-to-service-calls`,
    });
    await expect(issuer.create("KEY prod")).rejects.toThrow("checkAccount hasn't passed");
    await expect(issuer.revoke("key-default")).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
    expectNoSecret(check);
  });

  test("refuses a key with a custom JWT template before any write", async () => {
    const custom: SupabaseKey[] = KEYS.map((key) =>
      key.id === "key-backend" ? { ...key, template: { role: "app_reader", tenant: "t1" } } : key,
    );
    const { issuer, effects } = supabase({}, custom);
    const check = await issuer.checkAccount(null, new Secret(BACKEND));
    assert(!check.ok);
    expect(check.reason).toContain("custom secret_jwt_template");
    await expect(issuer.create("KEY prod")).rejects.toThrow("checkAccount hasn't passed");
    await expect(issuer.revoke("key-backend")).rejects.toThrow("checkAccount hasn't passed");
    expect(effects).toEqual([]);
    expectNoSecret(check);
  });

  test("accepts the default service_role template", async () => {
    const plain: SupabaseKey[] = KEYS.map((key) =>
      key.id === "key-backend" ? { ...key, template: { role: "service_role" } } : key,
    );
    const { issuer } = supabase({}, plain);
    expect((await issuer.checkAccount(null, new Secret(BACKEND))).ok).toBe(true);
  });

  test("refuses when two listed prefixes match the vault's key", async () => {
    const twin: SupabaseKey = {
      id: "key-twin",
      name: "twin",
      type: "secret",
      value: `${BACKEND.slice(0, 15)}other_0000`,
    };
    const { issuer } = supabase({}, [...KEYS, twin]);
    const check = await issuer.checkAccount(null, new Secret(BACKEND));
    expect(check).toMatchObject({
      ok: false,
      reason:
        "keys backend and twin start like the vault's key, so keypin can't tell which one it holds",
    });
  });

  test("refuses a vault key the project doesn't list", async () => {
    const { issuer } = supabase();
    const check = await issuer.checkAccount(null, new Secret("sb_secret_elsewhere00000_1111"));
    expect(check).toMatchObject({
      ok: false,
      reason: `Supabase project ${REF} has no secret key that matches the vault's key`,
    });
  });

  test("refuses when the key keypin issued last is gone but the vault's key is listed", async () => {
    const { issuer } = supabase();
    const check = await issuer.checkAccount("key-gone", new Secret(BACKEND));
    expect(check).toMatchObject({
      ok: false,
      reason:
        "Supabase doesn't list key key-gone, the one keypin issued last, but lists the vault's key as backend",
    });
  });

  test.each([
    [
      401,
      "Supabase doesn't accept the admin token: it expired or was deleted, or the item holds another value",
      "https://supabase.com/dashboard/account/tokens",
    ],
    [
      403,
      `the admin token can't read the API keys of Supabase project ${REF}: the ref is wrong, or the token isn't scoped to the project or lacks the API Keys permission`,
      "API Keys Read-write",
    ],
  ])("explains HTTP %i on the list", async (status, reason, fix) => {
    const { issuer } = supabase({ failList: status });
    const check = await issuer.checkAccount(null, new Secret(BACKEND));
    assert(!check.ok);
    expect(check.facts).toBe(`Supabase answered HTTP ${status}`);
    expect(check.reason).toBe(reason);
    expect(check.fix).toContain(fix);
  });

  test("a wrong admin token is a 401", async () => {
    const { issuer } = supabase({ admin: "sbp_other" });
    expect(await issuer.checkAccount(null, new Secret(BACKEND))).toMatchObject({
      ok: false,
      facts: "Supabase answered HTTP 401",
    });
  });

  test("another project ref is refused, not created in", async () => {
    const { issuer } = supabase({ projectRef: "zyxwvutsrqponmlkjihg" });
    expect(await issuer.checkAccount(null, new Secret(BACKEND))).toMatchObject({
      ok: false,
      facts: "Supabase answered HTTP 403",
    });
  });

  test("throws on an unexpected status, without the admin token", async () => {
    const { issuer } = supabase({ failList: 500 });
    const error = await issuer.checkAccount(null, new Secret(BACKEND)).catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe("Supabase GET /api-keys returned HTTP 500");
    expectNoSecret(error);
  });
});

describe("create", () => {
  test("creates a secret key with a name Supabase accepts and reveals its value", async () => {
    const { issuer, requests, world, effects } = supabase();
    await issuer.checkAccount(null, new Secret(BACKEND));
    const created = await issuer.create("web SUPABASE_SECRET_KEY prod 2026-11-16T21:49Z a1b2c3");
    expect(created.id).toBe("key-new-1");
    expect(created.secret.reveal()).toBe(`${PREFIX}1_c4e1`);
    expect(requests.at(-1)).toBe(`POST /v1/projects/${REF}/api-keys?reveal=true`);
    expect(world.load().keys.at(-1)?.name).toBe(
      "web_supabase_secret_key_prod_2026_11_16t21_49z_a1b2c3",
    );
    expect(effects).toEqual(["supabase create key-new-1"]);
  });

  test.each([
    ["9_KEYS prod", "_9_keys_prod"],
    [`${"İ".repeat(40)} KEY prod 2026-11-24T16:12Z a1b2c3`, `${"i_".repeat(28)}a1b2c3`],
    [
      "orbit-ci PULLFROG_OPENAI_API_KEY production 2026-11-24T16:12Z 668dbf",
      "orbit_ci_pullfrog_openai_api_key_prod_2026_11_24t16_12z_668dbf",
    ],
    [`${"9".repeat(70)} a1b2c3`, `_${"9".repeat(55)}_a1b2c3`],
  ])("fits %s to Supabase's name rules", async (name, fitted) => {
    const { issuer, world } = supabase();
    await issuer.checkAccount(null, new Secret(BACKEND));
    await issuer.create(name);
    expect(world.load().keys.at(-1)?.name).toBe(fitted);
  });

  test("a 403 changes nothing and names the permissions", async () => {
    const { issuer } = supabase({ failCreate: 403 });
    await issuer.checkAccount(null, new Secret(BACKEND));
    const error = await issuer.create("KEY prod").catch((e: unknown) => e);
    assert(error instanceof NothingChanged);
    expect(error.message).toContain("API Keys Read-write and API Key Secrets Read");
  });

  test("another 4xx changes nothing; a 5xx may have", async () => {
    const refused = supabase({ failCreate: 429 });
    await refused.issuer.checkAccount(null, new Secret(BACKEND));
    expect(await refused.issuer.create("KEY prod").catch((e: unknown) => e)).toBeInstanceOf(
      NothingChanged,
    );
    const failed = supabase({ failCreate: 500 });
    await failed.issuer.checkAccount(null, new Secret(BACKEND));
    const error = await failed.issuer.create("KEY prod").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error).not.toBeInstanceOf(NothingChanged);
    expectNoSecret(error);
  });

  test("a created key without its value says which permission is missing", async () => {
    const { issuer, effects } = supabase({ hideValues: true });
    await issuer.checkAccount(null, new Secret(BACKEND));
    const error = await issuer.create("KEY prod").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error).not.toBeInstanceOf(NothingChanged);
    expect(error.message).toBe(
      "Supabase created key key-new-1 but didn't return its value: the token needs API Key Secrets Read as well as API Keys Read-write; see https://supabase.com/docs/guides/platform/personal-access-tokens",
    );
    expect(effects).toEqual(["supabase create key-new-1"]);
    expectNoSecret(error);
  });

  test("a reply with only the 15-character prefix is refused, not saved as the key", async () => {
    const { issuer, effects } = supabase({ prefixOnly: true });
    await issuer.checkAccount(null, new Secret(BACKEND));
    const error = await issuer.create("KEY prod").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error).not.toBeInstanceOf(NothingChanged);
    expect(error.message).toContain("didn't return its value");
    expect(effects).toEqual(["supabase create key-new-1"]);
    expectNoSecret(error);
  });

  test("a lost reply is a plain error, and lostCreate names the key to delete", async () => {
    const { issuer, effects } = supabase({ loseCreated: true });
    await issuer.checkAccount(null, new Secret(BACKEND));
    const error = await issuer.create("KEY prod 2026-11-16").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error).not.toBeInstanceOf(NothingChanged);
    expect(effects).toEqual(["supabase create key-new-1"]);
    expect(issuer.lostCreate("KEY prod 2026-11-16")).toBe(
      `Supabase may have made the key before the reply was lost. Only this run uses the name "key_prod_2026_11_16": delete a secret key with that name at https://supabase.com/dashboard/project/${REF}/settings/api-keys before you run this again, or the rerun leaves it live.`,
    );
  });
});

describe("revoke", () => {
  test("deletes the key, and a missing key is already gone", async () => {
    const { issuer, effects } = supabase();
    await issuer.checkAccount(null, new Secret(BACKEND));
    expect(await issuer.revoke("key-backend")).toBe("revoked");
    expect(await issuer.revoke("key-backend")).toBe("already gone");
    expect(effects).toEqual(["supabase revoke key-backend"]);
  });

  test("never deletes the key named default", async () => {
    const { issuer, effects } = supabase();
    await issuer.checkAccount(null, new Secret(BACKEND));
    await expect(issuer.revoke("key-default")).rejects.toThrow(
      "keypin won't delete Supabase key key-default: it's the secret key named default",
    );
    expect(effects).toEqual([]);
  });
});

describe("secretspec.toml", () => {
  const map = (fields: string) => `
[project]
name = "app"
revision = "1.0"

[profiles.prod]
SUPABASE_SECRET_KEY = { description = "a key", providers = ["onepassword://my.1password.com@Private"], ref = { item = "app supabase key", field = "credential" } }

[tool.keypin.prod.SUPABASE_SECRET_KEY]
issuer = { kind = "supabase", admin = "op://Private/supabase token/credential"${fields} }
`;
  const parse = (fields: string) =>
    readSecretspec(map(fields), "/w/secretspec.toml", [], [supabaseIssuer], [onePasswordVault]);

  test("reads the issuer table", () => {
    const parsed = parse(`, project_ref = "${REF}"`);
    assert(parsed.ok);
    expect(parsed.map.keys[0]?.environments.prod?.issuer).toMatchObject({
      kind: "supabase",
      projectRef: REF,
    });
  });

  test.each([
    ["", `field "project_ref"`],
    [`, project_ref = "<ref>"`, `field "project_ref" is a <...> placeholder`],
    [
      `, project_ref = "https://abcdefghijklmnopqrst.supabase.co"`,
      `field "project_ref" must be the project's 20-letter ref, from its dashboard URL`,
    ],
    [`, project_ref = "${REF}", type = "secret"`, `"type"`],
  ])("refuses %s", (fields, error) => {
    const parsed = parse(fields);
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain(error);
  });
});
