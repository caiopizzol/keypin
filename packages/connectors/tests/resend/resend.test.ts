import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, Secret } from "@keypin/core";
import { ResendIssuer, type ResendIssuerOptions } from "../../src/resend/index";

const ADMIN = "re_admin_sentinel_5c1f";
const ISSUED = "re_issued_sentinel_8a2d";

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
  };
}

function issuer(routes: Routes, options: Partial<ResendIssuerOptions> = {}) {
  const requests: { method: string; url: string; headers: Record<string, string>; body: string }[] =
    [];
  let reads = 0;
  const fetch: Fetch = async (url, init) => {
    requests.push({ method: init.method, url, headers: init.headers, body: init.body ?? "" });
    const reply = routes[`${init.method} ${new URL(url).pathname}`] ?? {
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
}

describe("checkAccount", () => {
  test("lists keys with the admin key, a User-Agent, and reads the admin key once", async () => {
    const { resend, requests, reads } = issuer(happyRoutes());
    expect(await resend.checkAccount(null)).toEqual({
      ok: true,
      facts: "the admin key lists 1 API key",
    });
    await resend.checkAccount("key-old");
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "https://api.resend.com/api-keys",
      headers: { Authorization: `Bearer ${ADMIN}`, "User-Agent": "keypin" },
    });
    expect(reads()).toBe(1);
  });

  test("the key keypin issued last time must be listed, or the admin key is another team's", async () => {
    const { resend, requests } = issuer(happyRoutes());
    const check = await resend.checkAccount("key-elsewhere");
    expect(check).toMatchObject({ ok: false });
    expect(check.reason).toContain("doesn't list key key-elsewhere");
    await expect(resend.create("RESEND_API_KEY")).rejects.toThrow(/checkAccount hasn't passed/);
    await expect(resend.revoke("key-old")).rejects.toThrow(/checkAccount hasn't passed/);
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  test("a sending-only admin key can't manage keys", async () => {
    const routes = happyRoutes();
    routes["GET /api-keys"] = {
      status: 401,
      body: { statusCode: 401, name: "restricted_api_key", message: "restricted" },
    };
    const check = await issuer(routes).resend.checkAccount(null);
    expect(check).toMatchObject({
      ok: false,
      facts: "Resend answered HTTP 401 restricted_api_key",
      reason: "the admin key can only send emails, so it can't create or delete keys",
    });
  });

  test("a deleted or wrong admin key", async () => {
    const routes = happyRoutes();
    routes["GET /api-keys"] = {
      status: 400,
      body: { statusCode: 400, name: "validation_error", message: "API key is invalid" },
    };
    const check = await issuer(routes).resend.checkAccount(null);
    expect(check).toMatchObject({ ok: false, facts: "Resend answered HTTP 400 validation_error" });
    expect(check.reason).toContain("doesn't accept the admin key");
  });

  test("a server error throws, without the admin key", async () => {
    const routes = happyRoutes();
    routes["GET /api-keys"] = { status: 500, body: { message: `boom ${ADMIN}` } };
    const error: unknown = await issuer(routes)
      .resend.checkAccount(null)
      .catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe("Resend GET /api-keys returned HTTP 500");
    expectNoSecret(error);
  });
});

describe("create", () => {
  test("POSTs the name, permission and domain, and returns the id and token", async () => {
    const { resend, requests } = issuer(happyRoutes(), { domainId: "domain-1" });
    await resend.checkAccount(null);
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
    await resend.checkAccount(null);
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
    await refused.checkAccount(null);
    const error: unknown = await refused.create("K").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toBe("Resend POST /api-keys returned HTTP 422 invalid_parameter");
    expect(error).toBeInstanceOf(NothingChanged);
    expectNoSecret(error);

    routes["POST /api-keys"] = { status: 201, body: { id: "key-new" } };
    const empty = issuer(routes).resend;
    await empty.checkAccount(null);
    await expect(empty.create("K")).rejects.toThrow("has no id and token");
  });
});

describe("after a failed create", () => {
  test("a server error may have made the key, so it isn't NothingChanged", async () => {
    const routes = happyRoutes();
    routes["POST /api-keys"] = { status: 502, body: { name: "internal_server_error" } };
    const { resend } = issuer(routes);
    await resend.checkAccount(null);
    const error: unknown = await resend.create("K").catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error).not.toBeInstanceOf(NothingChanged);
  });

  test("a create that answers 2xx or 3xx without a key isn't counted as nothing created", async () => {
    const routes = happyRoutes();
    routes["POST /api-keys"] = { status: 202, body: {} };
    const { resend } = issuer(routes);
    await resend.checkAccount(null);
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
    await resend.checkAccount("key-old");
    expect(await resend.revoke("key-old")).toBe("revoked");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.resend.com/api-keys/key-old",
    });
  });

  test("a key that's already gone is not an error", async () => {
    const { resend } = issuer(happyRoutes());
    await resend.checkAccount(null);
    expect(await resend.revoke("key-gone")).toBe("already gone");
  });

  test("the id is one path segment", async () => {
    const { resend, requests } = issuer(happyRoutes());
    await resend.checkAccount(null);
    await resend.revoke("../domains/d-1");
    expect(requests.at(-1)?.url).toBe("https://api.resend.com/api-keys/..%2Fdomains%2Fd-1");
  });

  test("another failure throws", async () => {
    const routes = happyRoutes();
    routes["DELETE /api-keys/key-old"] = { status: 500 };
    const { resend } = issuer(routes);
    await resend.checkAccount(null);
    await expect(resend.revoke("key-old")).rejects.toThrow(
      "Resend DELETE /api-keys/<id> returned HTTP 500",
    );
  });
});
