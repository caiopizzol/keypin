import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, RevokeRefused, Secret } from "@keypin/core";
import { SendGridIssuer, type SendGridIssuerOptions } from "../../src/sendgrid/index";
import {
  ADMIN_SCOPES,
  type FakeSendGrid,
  type FakeSendGridKey,
  memoryWorld,
  sendgridFetch,
} from "../../src/sendgrid/testing";

const ADMIN = "SG.AdminKeyId.admin_sentinel_5c1f";
const VAULT = new Secret("SG.OldKeyId.vault_sentinel_2f4b");
const PREFIX = "issued_sentinel_8a2d_";
const OLD: FakeSendGridKey = {
  id: "OldKeyId",
  name: "mailer",
  value: VAULT.reveal(),
  scopes: ["mail.send", "templates.read", "sender_verification_eligible", "2fa_required"],
};

const NEXT_VAULT = new Secret("SG.NextKeyId.next_sentinel_7e3c");
const NEXT: FakeSendGridKey = {
  ...OLD,
  id: "NextKeyId",
  name: "mailer 2",
  value: NEXT_VAULT.reveal(),
};

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function setup(
  fake: Partial<FakeSendGrid> = {},
  options: Partial<SendGridIssuerOptions> = {},
  keys: FakeSendGridKey[] = [OLD],
) {
  const effects: string[] = [];
  const requests: Seen[] = [];
  const world = memoryWorld(keys);
  const inner = sendgridFetch({
    admin: ADMIN,
    valuePrefix: PREFIX,
    world,
    effect: (line) => void effects.push(line),
    ...fake,
  });
  const fetch: Fetch = async (url, init) => {
    requests.push({ method: init.method, url, headers: init.headers, body: init.body ?? "" });
    return inner(url, init);
  };
  let reads = 0;
  const sendgrid = new SendGridIssuer({
    admin: async () => {
      reads++;
      return new Secret(ADMIN);
    },
    fetch,
    ...options,
  });
  return { sendgrid, effects, requests, world, reads: () => reads };
}

function routed(routes: Record<string, { status: number; body?: unknown }>) {
  const fetch: Fetch = async (url, init) => {
    const reply = routes[`${init.method} ${new URL(url).pathname}`] ?? { status: 404, body: {} };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
    });
  };
  return new SendGridIssuer({ admin: async () => new Secret(ADMIN), fetch });
}

const SCOPES_OK = { status: 200, body: { scopes: ADMIN_SCOPES } };
const OLD_KEY = {
  status: 200,
  body: { result: [{ api_key_id: "OldKeyId", name: "mailer", scopes: ["mail.send"] }] },
};

function expectNoSecret(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  expect(text).not.toContain(ADMIN);
  expect(text).not.toContain(PREFIX);
  expect(text).not.toContain(VAULT.reveal());
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.catch((e: unknown) => e);
  assert(error instanceof Error);
  return error;
}

describe("checkAccount", () => {
  test("finds the vault's key by the ID inside it and plans a copy of its scopes", async () => {
    const { sendgrid, requests, reads } = setup();
    const check = await sendgrid.checkAccount(null, VAULT);
    expect(check).toEqual({
      ok: true,
      facts: 'the admin key manages API keys; the vault holds key "mailer"',
      currentId: "OldKeyId",
      notes: { create: "with the old key's 2 scopes" },
    });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://api.sendgrid.com/v3/scopes",
      "GET https://api.sendgrid.com/v3/api_keys/OldKeyId",
    ]);
    expect(requests[0]?.headers).toMatchObject({
      Authorization: `Bearer ${ADMIN}`,
      "User-Agent": "keypin",
    });
    expect(requests.every((r) => r.headers.Authorization === `Bearer ${ADMIN}`)).toBe(true);
    expect(reads()).toBe(1);
    expect(sendgrid.label("OldKeyId")).toBe('"mailer"');
    expectNoSecret(check);
  });

  test("the key keypin issued last time is looked up by its ID, and no currentId comes back", async () => {
    const { sendgrid } = setup();
    const check = await sendgrid.checkAccount("OldKeyId", new Secret("anything"));
    assert(check.ok);
    expect(check.currentId).toBeUndefined();
  });

  test("an admin key without the API Keys permission is refused", async () => {
    const { sendgrid, effects } = setup({ adminScopes: ["mail.send", "api_keys.read"] });
    const check = await sendgrid.checkAccount(null, VAULT);
    expect(check).toEqual({
      ok: false,
      facts: "the admin key has 2 scopes, without api_keys.create, api_keys.delete",
      reason: "the admin key can't create and delete API keys",
      fix: "put a key with Full Access, or with API Keys Full Access, in the admin item; create one at https://app.sendgrid.com/settings/api_keys",
    });
    await expect(sendgrid.create("K")).rejects.toThrow(/checkAccount hasn't passed/);
    await expect(sendgrid.revoke("OldKeyId", VAULT)).rejects.toThrow(/checkAccount hasn't passed/);
    expect(effects).toEqual([]);
  });

  test("a deleted or wrong admin key, and a hint for an EU key on the global host", async () => {
    const { sendgrid } = setup({ admin: "SG.Other.admin" });
    const check = await sendgrid.checkAccount(null, VAULT);
    assert(!check.ok);
    expect(check.facts).toBe("SendGrid answered HTTP 401");
    expect(check.reason).toBe(
      `SendGrid doesn't accept the admin key: it was deleted, the item holds another value, or it's an EU regional subuser's key (set region = "eu")`,
    );
    const eu = setup({ admin: "SG.Other.admin", region: "eu" }, { region: "eu" });
    const euCheck = await eu.sendgrid.checkAccount(null, VAULT);
    assert(!euCheck.ok);
    expect(euCheck.reason).not.toContain("region");
  });

  test("the same key in the admin item and the vault is refused before any request", async () => {
    const { sendgrid, requests } = setup();
    const check = await sendgrid.checkAccount(null, new Secret(ADMIN));
    expect(check).toMatchObject({
      ok: false,
      reason: "the vault's key is the admin key keypin signs in with",
    });
    expect(requests).toEqual([]);
  });

  test("a whitespace-padded copy of the admin key is refused, and create and revoke stay gated", async () => {
    const { sendgrid, requests } = setup();
    const check = await sendgrid.checkAccount(null, new Secret(`${ADMIN}\n`));
    expect(check).toMatchObject({
      ok: false,
      reason: "the vault's key is the admin key keypin signs in with",
    });
    expect(requests).toEqual([]);
    await expect(sendgrid.create("next")).rejects.toThrow("checkAccount hasn't passed");
    await expect(sendgrid.revoke("AdminKeyId", VAULT)).rejects.toThrow(
      "checkAccount hasn't passed",
    );
    expect(requests).toEqual([]);
  });

  test("an issued key ID that is the admin key's is refused", async () => {
    const { sendgrid, requests } = setup();
    const check = await sendgrid.checkAccount("AdminKeyId", VAULT);
    expect(check).toMatchObject({
      ok: false,
      reason: "the vault's key is the admin key keypin signs in with",
    });
    expect(requests).toEqual([]);
  });

  test("a recorded key ID that isn't the one in the vault's value is refused, so create can't copy its scopes", async () => {
    const { sendgrid, effects } = setup({}, {}, [OLD, NEXT]);
    const check = await sendgrid.checkAccount("NextKeyId", VAULT);
    expect(check).toMatchObject({
      ok: false,
      reason:
        "key NextKeyId, the one keypin recorded for the vault's value, is another key: the vault holds key OldKeyId",
      fix: "check .keypin/rotation.json for a change you didn't make",
    });
    await expect(sendgrid.create("K")).rejects.toThrow(/checkAccount hasn't passed/);
    expect(effects).toEqual([]);
  });

  test("a vault value that isn't SG.<id>.<secret> is refused", async () => {
    const { sendgrid } = setup();
    const check = await sendgrid.checkAccount(null, new Secret("re_not_sendgrid"));
    expect(check).toMatchObject({
      ok: false,
      reason: "the vault's value isn't a SendGrid API key, which looks like SG.<id>.<secret>",
    });
  });

  test("a vault key the admin key's account doesn't have is refused, naming it", async () => {
    const { sendgrid } = setup({}, {}, []);
    const check = await sendgrid.checkAccount(null, VAULT);
    assert(!check.ok);
    expect(check.reason).toBe(
      "the admin key's account has no key OldKeyId, the vault's key: it was deleted, or it's from another account or region",
    );
    const issued = await sendgrid.checkAccount("NewKey9Id", new Secret("SG.NewKey9Id.issued"));
    assert(!issued.ok);
    expect(issued.reason).toContain("no key NewKey9Id, the one keypin issued last time");
    await expect(sendgrid.create("K")).rejects.toThrow(/checkAccount hasn't passed/);
  });

  test("a scope the admin key can't grant is refused before create", async () => {
    const { sendgrid, effects } = setup({}, {}, [
      { ...OLD, scopes: ["mail.send", "billing.read", "2fa_required"] },
    ]);
    const check = await sendgrid.checkAccount(null, VAULT);
    expect(check).toMatchObject({
      ok: false,
      reason:
        "key \"mailer\" has 1 scope the admin key doesn't have, so it can't give them to a new key: billing.read",
    });
    await expect(sendgrid.create("K")).rejects.toThrow(/checkAccount hasn't passed/);
    expect(effects).toEqual([]);
  });

  test("a key with only scopes SendGrid sets itself has nothing to copy", async () => {
    const { sendgrid } = setup({}, {}, [{ ...OLD, scopes: ["2fa_required"] }]);
    const check = await sendgrid.checkAccount(null, VAULT);
    expect(check).toMatchObject({
      ok: false,
      reason: `SendGrid shows no scopes for key "mailer", so keypin can't give the new key the same ones`,
    });
  });

  test("reads the retrieve response with or without its result array", async () => {
    const bare = routed({
      "GET /v3/scopes": SCOPES_OK,
      "GET /v3/api_keys/OldKeyId": {
        status: 200,
        body: { api_key_id: "OldKeyId", name: "mailer", scopes: ["mail.send"] },
      },
    });
    expect((await bare.checkAccount(null, VAULT)).ok).toBe(true);
    const wrapped = routed({ "GET /v3/scopes": SCOPES_OK, "GET /v3/api_keys/OldKeyId": OLD_KEY });
    expect((await wrapped.checkAccount(null, VAULT)).ok).toBe(true);
    const other = routed({
      "GET /v3/scopes": SCOPES_OK,
      "GET /v3/api_keys/OldKeyId": { status: 200, body: { result: [] } },
    });
    await expect(other.checkAccount(null, VAULT)).rejects.toThrow("has no key");
  });

  test("a server error throws, without the admin key", async () => {
    const issuer = routed({
      "GET /v3/scopes": { status: 500, body: { errors: [{ message: ADMIN }] } },
    });
    const error = await caught(issuer.checkAccount(null, VAULT));
    expect(error.message).toBe("SendGrid GET /v3/scopes returned HTTP 500");
    expectNoSecret(error);
    const lookup = routed({
      "GET /v3/scopes": SCOPES_OK,
      "GET /v3/api_keys/OldKeyId": { status: 502 },
    });
    await expect(lookup.checkAccount(null, VAULT)).rejects.toThrow(
      "SendGrid GET /v3/api_keys/<id> returned HTTP 502",
    );
  });
});

describe("subusers and regions", () => {
  const SUB_KEY: FakeSendGridKey = { ...OLD, subuser: "shop" };

  test("a subuser's key is found, made and deleted on behalf of the subuser", async () => {
    const { sendgrid, requests, effects } = setup({ subusers: ["shop"] }, { subuser: "shop" }, [
      SUB_KEY,
    ]);
    const check = await sendgrid.checkAccount(null, VAULT);
    expect(check).toMatchObject({
      ok: true,
      facts: 'the admin key manages API keys of subuser shop; the vault holds key "mailer"',
    });
    const created = await sendgrid.create("MAIL_KEY prod");
    expect(await sendgrid.revoke("OldKeyId", created.secret)).toBe("revoked");
    expect(requests[0]?.headers["on-behalf-of"]).toBeUndefined();
    expect(requests.slice(1).map((r) => r.headers["on-behalf-of"])).toEqual([
      "shop",
      "shop",
      "shop",
      "shop",
      "shop",
    ]);
    expect(effects).toEqual([
      "sendgrid create NewKey1Id for shop with mail.send,templates.read",
      "sendgrid revoke OldKeyId for shop",
    ]);
  });

  test("a subuser key without subuser in secretspec.toml isn't found in the parent account", async () => {
    const { sendgrid } = setup({ subusers: ["shop"] }, {}, [SUB_KEY]);
    const check = await sendgrid.checkAccount(null, VAULT);
    assert(!check.ok);
    expect(check.reason).toContain("the admin key's account has no key OldKeyId");
    expect(check.fix).toContain("subuser and region in secretspec.toml");
  });

  test("a subuser the admin key's account doesn't have is refused", async () => {
    const { sendgrid } = setup({ subusers: ["shop"] }, { subuser: "typo" }, [SUB_KEY]);
    const check = await sendgrid.checkAccount(null, VAULT);
    assert(!check.ok);
    expect(check.facts).toBe("SendGrid answered HTTP 403");
    expect(check.reason).toBe(
      "SendGrid refused the admin key for subuser typo: the subuser doesn't exist, or the admin key isn't from its parent account",
    );
  });

  test('region = "eu" calls api.eu.sendgrid.com', async () => {
    const { sendgrid, requests } = setup({ region: "eu" }, { region: "eu" });
    expect((await sendgrid.checkAccount(null, VAULT)).ok).toBe(true);
    expect(requests.every((r) => r.url.startsWith("https://api.eu.sendgrid.com/v3/"))).toBe(true);
  });
});

describe("create", () => {
  test("POSTs the name and the old key's scopes, without the ones SendGrid sets itself", async () => {
    const { sendgrid, requests, effects } = setup();
    await sendgrid.checkAccount(null, VAULT);
    const created = await sendgrid.create("MAIL_KEY prod 2026-11-18 12:00:00 a1b2c3");
    expect(created.id).toBe("NewKey1Id");
    expect(created.secret.reveal()).toBe(`SG.NewKey1Id.${PREFIX}1x9Qa`);
    const post = requests.find((r) => r.method === "POST");
    assert(post);
    expect(post.url).toBe("https://api.sendgrid.com/v3/api_keys");
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(post.body)).toEqual({
      name: "MAIL_KEY prod 2026-11-18 12:00:00 a1b2c3",
      scopes: ["mail.send", "templates.read"],
    });
    expect(effects).toEqual(["sendgrid create NewKey1Id with mail.send,templates.read"]);
    expectNoSecret(created.id, sendgrid.describe(), sendgrid.dashboard());
  });

  test("an account at 100 keys is refused, and nothing was created", async () => {
    const many = Array.from({ length: 99 }, (_, i) => ({
      ...OLD,
      id: `Other${i}`,
      value: `SG.Other${i}.x`,
    }));
    const { sendgrid, effects } = setup({}, {}, [OLD, ...many]);
    await sendgrid.checkAccount(null, VAULT);
    const error = await caught(sendgrid.create("K"));
    expect(error).toBeInstanceOf(NothingChanged);
    expect(error.message).toContain("100 API keys");
    expect(effects).toEqual([]);
  });

  test("a refusal is NothingChanged; a server error or an empty 2xx may have made the key", async () => {
    const refused = setup({ failCreate: 400 }).sendgrid;
    await refused.checkAccount(null, VAULT);
    const bad = await caught(refused.create("K"));
    expect(bad).toBeInstanceOf(NothingChanged);
    expect(bad.message).toBe("SendGrid POST /v3/api_keys returned HTTP 400");
    expectNoSecret(bad);

    const broken = setup({ failCreate: 500 }).sendgrid;
    await broken.checkAccount(null, VAULT);
    expect(await caught(broken.create("K"))).not.toBeInstanceOf(NothingChanged);

    const empty = routed({
      "GET /v3/scopes": SCOPES_OK,
      "GET /v3/api_keys/OldKeyId": OLD_KEY,
      "POST /v3/api_keys": { status: 201, body: { api_key_id: "NewKeyId" } },
    });
    await empty.checkAccount(null, VAULT);
    const none = await caught(empty.create("K"));
    expect(none.message).toBe(
      "SendGrid's POST /v3/api_keys response has no api_key_id and api_key",
    );
    expect(none).not.toBeInstanceOf(NothingChanged);
  });

  test("a lost create names the key, and the subuser that holds it", () => {
    const name = "MAIL_KEY prod 2026-11-18 12:00:00 a1b2c3";
    expect(setup().sendgrid.lostCreate(name)).toBe(
      `SendGrid may have made the key before the reply was lost. Only this run uses the name "${name}": delete a key with that name at https://app.sendgrid.com/settings/api_keys before you run this again, or the rerun leaves it live.`,
    );
    expect(setup({}, { subuser: "shop" }).sendgrid.lostCreate(name)).toContain(
      "with that name in subuser shop at",
    );
  });
});

describe("revoke", () => {
  test("DELETEs the retired key by ID once the vault holds the new one; a missing key is already gone", async () => {
    const { sendgrid, requests } = setup({}, {}, [OLD, NEXT]);
    await sendgrid.checkAccount(null, NEXT_VAULT);
    expect(await sendgrid.revoke("OldKeyId", NEXT_VAULT)).toBe("revoked");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.sendgrid.com/v3/api_keys/OldKeyId",
    });
    expect(await sendgrid.revoke("OldKeyId", NEXT_VAULT)).toBe("already gone");
  });

  test("the ID is one path segment, and a key the account doesn't have is never deleted", async () => {
    const { sendgrid, requests } = setup({}, {}, [OLD, NEXT]);
    await sendgrid.checkAccount(null, NEXT_VAULT);
    expect(await sendgrid.revoke("../scopes", NEXT_VAULT)).toBe("already gone");
    expect(requests.at(-1)?.url).toBe("https://api.sendgrid.com/v3/api_keys/..%2Fscopes");
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("refuses the key the vault holds and the admin key, before any request", async () => {
    const { sendgrid, requests, effects } = setup({}, {}, [OLD, NEXT]);
    await sendgrid.checkAccount(null, NEXT_VAULT);
    const before = requests.length;
    await expect(sendgrid.revoke("NextKeyId", NEXT_VAULT)).rejects.toThrow(
      new RevokeRefused("it's the key the vault holds"),
    );
    await expect(sendgrid.revoke("AdminKeyId", NEXT_VAULT)).rejects.toThrow(
      new RevokeRefused("it's the admin key"),
    );
    expect(requests).toHaveLength(before);
    expect(effects).toEqual([]);
  });

  test("refuses when the vault's key isn't in the same account, or the vault's value names no key", async () => {
    const { sendgrid, requests } = setup({ subusers: ["shop"] }, { subuser: "shop" }, [
      { ...OLD, subuser: "shop" },
      NEXT,
    ]);
    await sendgrid.checkAccount(null, VAULT);
    await expect(sendgrid.revoke("OldKeyId", NEXT_VAULT)).rejects.toThrow(
      new RevokeRefused("it's in the subuser shop, and the vault's key NextKeyId isn't"),
    );
    await expect(sendgrid.revoke("OldKeyId", new Secret("not-sendgrid"))).rejects.toThrow(
      new RevokeRefused("keypin can't tell which key in the subuser shop the vault holds"),
    );
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("has throws when SendGrid refuses the lookup", async () => {
    const issuer = routed({ "GET /v3/api_keys/OldKeyId": { status: 403 } });
    await expect(issuer.has("OldKeyId")).rejects.toThrow(
      "SendGrid GET /v3/api_keys/<id> returned HTTP 403",
    );
  });

  test("a refused or failed delete throws, naming where to delete it by hand", async () => {
    const issuer = (status: number) =>
      routed({
        "GET /v3/scopes": SCOPES_OK,
        "GET /v3/api_keys/OldKeyId": OLD_KEY,
        "GET /v3/api_keys/NextKeyId": OLD_KEY,
        "DELETE /v3/api_keys/OldKeyId": { status },
      });
    const forbidden = issuer(403);
    await forbidden.checkAccount(null, VAULT);
    await expect(forbidden.revoke("OldKeyId", NEXT_VAULT)).rejects.toThrow(
      `the admin key can't delete key "mailer" (HTTP 403): delete it at https://app.sendgrid.com/settings/api_keys`,
    );
    const broken = issuer(500);
    await broken.checkAccount(null, VAULT);
    await expect(broken.revoke("OldKeyId", NEXT_VAULT)).rejects.toThrow(
      "SendGrid DELETE /v3/api_keys/<id> returned HTTP 500",
    );
  });
});
