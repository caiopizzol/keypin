import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, Secret } from "@keypin/core";
import { ResendIssuer, type ResendIssuerOptions } from "../../src/resend/index";

const ADMIN = "re_admin_sentinel_5c1f";
const ISSUED = "re_issued_sentinel_8a2d";
const VAULT = new Secret("re_vault_sentinel_2f4b");
const SENDING_ONLY: Reply = {
  status: 401,
  body: { statusCode: 401, name: "restricted_api_key", message: "restricted" },
};

type Reply = { status: number; body?: unknown };
type Routes = Record<string, Reply>;

function happyRoutes(): Routes {
  return {
    "GET /api-keys": {
      status: 200,
      body: { object: "list", has_more: false, data: [{ id: "key-old", name: "Production" }] },
    },
    "POST /api-keys": { status: 201, body: { id: "key-new", object: "api_key", token: ISSUED } },
    "DELETE /api-keys/key-old": {
      status: 200,
      body: { object: "api_key", id: "key-old", deleted: true },
    },
    "vault GET /api-keys": SENDING_ONLY,
  };
}

function issuer(routes: Routes, options: Partial<ResendIssuerOptions> = {}) {
  const requests: { method: string; url: string; headers: Record<string, string>; body: string }[] =
    [];
  let reads = 0;
  const fetch: Fetch = async (url, init) => {
    requests.push({ method: init.method, url, headers: init.headers, body: init.body ?? "" });
    const asVault = init.headers.Authorization === `Bearer ${VAULT.reveal()}`;
    const route = `${asVault ? "vault " : ""}${init.method} ${new URL(url).pathname}`;
    const reply = routes[route] ?? {
      status: 404,
      body: { statusCode: 404, name: "not_found", message: "Not found" },
    };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
    });
  };
  const resend = new ResendIssuer({
    admin: async () => {
      reads++;
      return new Secret(ADMIN);
    },
    permission: "sending_access",
    fetch,
    ...options,
  });
  return { resend, requests, reads: () => reads };
}

function expectNoSecret(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  expect(text).not.toContain(ADMIN);
  expect(text).not.toContain(ISSUED);
  expect(text).not.toContain(VAULT.reveal());
}

describe("checkAccount", () => {
  test("lists keys with the admin key, a User-Agent, and reads the admin key once", async () => {
    const { resend, requests, reads } = issuer(happyRoutes());
    expect(await resend.checkAccount(null, VAULT)).toEqual({
      ok: true,
      facts: "the admin key lists 1 API key",
      notes: {
        create:
          "the vault's key can only send emails, so keypin can't check that the admin key is from its team",
      },
    });
    await resend.checkAccount("key-old", VAULT);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "https://api.resend.com/api-keys",
      headers: { Authorization: `Bearer ${ADMIN}`, "User-Agent": "keypin" },
    });
    expect(reads()).toBe(1);
  });

  test("the key keypin issued last time must be listed, or the admin key is another team's", async () => {
    const { resend, requests } = issuer(happyRoutes());
    const check = await resend.checkAccount("key-elsewhere", VAULT);
    expect(check).toMatchObject({ ok: false });
    expect(check.reason).toContain("doesn't list key key-elsewhere");
    expect(check.reason).toContain("the admin key belongs to another team");
    await expect(resend.create("RESEND_API_KEY")).rejects.toThrow(/checkAccount hasn't passed/);
    await expect(resend.revoke("key-old")).rejects.toThrow(/checkAccount hasn't passed/);
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET"]);
  });

  test("a sending-only admin key can't manage keys", async () => {
    const routes = happyRoutes();
    routes["GET /api-keys"] = SENDING_ONLY;
    const check = await issuer(routes).resend.checkAccount(null, VAULT);
    expect(check).toMatchObject({
      ok: false,
      facts: "Resend answered HTTP 401 restricted_api_key",
      reason: "the admin key can only send emails, so it can't create or delete keys",
    });
  });

  test("an admin key that isn't active isn't called sending-only", async () => {
    const routes = happyRoutes();
    routes["GET /api-keys"] = {
      status: 403,
      body: { statusCode: 403, name: "restricted_api_key", message: "API key is not active" },
    };
    const check = await issuer(routes).resend.checkAccount(null, VAULT);
    expect(check).toMatchObject({
      ok: false,
      facts: "Resend answered HTTP 403 restricted_api_key",
      reason: "the admin key isn't active at Resend",
    });
  });

  test("a vault key deleted at Resend leaves nothing to revoke", async () => {
    const routes = happyRoutes();
    routes["vault GET /api-keys"] = {
      status: 400,
      body: { statusCode: 400, name: "validation_error", message: "API key is invalid" },
    };
    const { resend } = issuer(routes);
    const check = await resend.checkAccount("key-leaked", VAULT);
    expect(check).toMatchObject({ ok: true, gone: "key key-leaked was deleted at Resend" });
    expect((await resend.create("K")).id).toBe("key-new");
    const first = await resend.checkAccount(null, VAULT);
    expect(first.gone).toContain("Resend doesn't accept the vault's key");
    expectNoSecret(check, first);
  });

  test("a full-access vault key from another team is refused before create", async () => {
    const routes = happyRoutes();
    routes["vault GET /api-keys"] = {
      status: 200,
      body: { object: "list", has_more: false, data: [{ id: "key-theirs", name: "Theirs" }] },
    };
    const { resend } = issuer(routes);
    const check = await resend.checkAccount(null, VAULT);
    expect(check).toMatchObject({
      ok: false,
      reason: "the vault's key and the admin key belong to different Resend teams",
    });
    await expect(resend.create("K")).rejects.toThrow(/checkAccount hasn't passed/);

    routes["vault GET /api-keys"] = routes["GET /api-keys"] ?? SENDING_ONLY;
    expect(await issuer(routes).resend.checkAccount(null, VAULT)).toEqual({
      ok: true,
      facts: "the admin key lists 1 API key, in the vault key's team",
    });
  });

  test("a domain_id the admin key's team doesn't have fails the check", async () => {
    const routes = happyRoutes();
    const wrong = await issuer(routes, { domainId: "dom-typo" }).resend.checkAccount(null, VAULT);
    expect(wrong).toMatchObject({
      ok: false,
      reason: "the admin key's team has no Resend domain dom-typo",
      fix: "check domain_id in keypin.toml against https://resend.com/domains",
    });
    routes["GET /domains/dom-1"] = {
      status: 200,
      body: { object: "domain", id: "dom-1", name: "mail.acme.dev", status: "verified" },
    };
    const right = await issuer(routes, { domainId: "dom-1" }).resend.checkAccount(null, VAULT);
    expect(right.facts).toBe("the admin key lists 1 API key and domain mail.acme.dev");
  });

  test("a deleted or wrong admin key", async () => {
    const routes = happyRoutes();
    routes["GET /api-keys"] = {
      status: 400,
      body: { statusCode: 400, name: "validation_error", message: "API key is invalid" },
    };
    const check = await issuer(routes).resend.checkAccount(null, VAULT);
    expect(check).toMatchObject({ ok: false, facts: "Resend answered HTTP 400 validation_error" });
    expect(check.reason).toContain("doesn't accept the admin key");
  });

  test("a server error throws, without the admin key", async () => {
    const routes = happyRoutes();
    routes["GET /api-keys"] = { status: 500, body: { message: `boom ${ADMIN}` } };
    const error: unknown = await issuer(routes)
      .resend.checkAccount(null, VAULT)
      .catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe("Resend GET /api-keys returned HTTP 500");
    expectNoSecret(error);
  });
});

describe("create", () => {
  test("POSTs the name, permission and domain, and returns the id and token", async () => {
    const routes = happyRoutes();
    routes["GET /domains/domain-1"] = { status: 200, body: { id: "domain-1", name: "acme.dev" } };
    const { resend, requests } = issuer(routes, { domainId: "domain-1" });
    await resend.checkAccount(null, VAULT);
    const created = await resend.create("RESEND_API_KEY prod 2026-11-14 keypin");
    expect(created.id).toBe("key-new");
    expect(created.secret.equals(new Secret(ISSUED))).toBe(true);
    const post = requests.find((r) => r.method === "POST");
    assert(post);
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(post.body)).toEqual({
      name: "RESEND_API_KEY prod 2026-11-14 keypin",
      permission: "sending_access",
      domain_id: "domain-1",
    });
    expectNoSecret(created, resend.describe());
    expect(resend.dashboard()).toBe("https://resend.com/api-keys");
  });

  test("a name longer than Resend's 50 characters keeps its end, where the time is", async () => {
    const { resend, requests } = issuer(happyRoutes(), { permission: "full_access" });
    await resend.checkAccount(null, VAULT);
    await resend.create(`${"A".repeat(60)} 12:00:00`);
    const post = requests.find((r) => r.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      name: `…${"A".repeat(40)} 12:00:00`,
      permission: "full_access",
    });
  });

  test("a refusal or a response without a token throws, without either key", async () => {
    const routes = happyRoutes();
    routes["POST /api-keys"] = {
      status: 422,
      body: { name: "invalid_parameter", message: `bad ${ADMIN}` },
    };
    const refused = issuer(routes).resend;
    await refused.checkAccount(null, VAULT);
    const error: unknown = await refused.create("K").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe("Resend POST /api-keys returned HTTP 422 invalid_parameter");
    expect(error).toBeInstanceOf(NothingChanged);
    expectNoSecret(error);

    routes["POST /api-keys"] = { status: 201, body: { id: "key-new" } };
    const empty = issuer(routes).resend;
    await empty.checkAccount(null, VAULT);
    await expect(empty.create("K")).rejects.toThrow("has no id and token");
  });
});

describe("after a failed create", () => {
  test("a server error may have made the key, so it isn't NothingChanged", async () => {
    const routes = happyRoutes();
    routes["POST /api-keys"] = { status: 502, body: { name: "internal_server_error" } };
    const { resend } = issuer(routes);
    await resend.checkAccount(null, VAULT);
    const error: unknown = await resend.create("K").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error).not.toBeInstanceOf(NothingChanged);
  });

  test("a create that answers 2xx or 3xx without a key isn't counted as nothing created", async () => {
    const routes = happyRoutes();
    routes["POST /api-keys"] = { status: 202, body: {} };
    const { resend } = issuer(routes);
    await resend.checkAccount(null, VAULT);
    const error: unknown = await resend.create("K").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error).not.toBeInstanceOf(NothingChanged);
  });

  test("a lost create names the key as Resend stores it, cut to 50 characters", () => {
    const name = `${"K".repeat(60)} prod 2026-11-09 12:00:00 a1b2c3`;
    const { resend } = issuer(happyRoutes());
    expect(resend.lostCreate(name)).toContain(`"…${name.slice(name.length - 49)}"`);
  });
});

describe("revoke", () => {
  test("DELETEs the key by id", async () => {
    const { resend, requests } = issuer(happyRoutes());
    await resend.checkAccount("key-old", VAULT);
    expect(await resend.revoke("key-old")).toBe("revoked");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.resend.com/api-keys/key-old",
    });
  });

  test("a key that's already gone is not an error", async () => {
    const { resend } = issuer(happyRoutes());
    await resend.checkAccount(null, VAULT);
    expect(await resend.revoke("key-gone")).toBe("already gone");
  });

  test("the id is one path segment", async () => {
    const { resend, requests } = issuer(happyRoutes());
    await resend.checkAccount(null, VAULT);
    await resend.revoke("../domains/d-1");
    expect(requests.at(-1)?.url).toBe("https://api.resend.com/api-keys/..%2Fdomains%2Fd-1");
  });

  test("another failure throws", async () => {
    const routes = happyRoutes();
    routes["DELETE /api-keys/key-old"] = { status: 500 };
    const { resend } = issuer(routes);
    await resend.checkAccount(null, VAULT);
    await expect(resend.revoke("key-old")).rejects.toThrow(
      "Resend DELETE /api-keys/<id> returned HTTP 500",
    );
  });
});
