import { describe, expect, test } from "vite-plus/test";
import { type ProviderToken, sameAccess, Secret } from "@keypin/core";
import { CloudflareAccountTokens, type Fetch } from "../src/index";

const ACCOUNT = "11111111111111111111111111111111";
const OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADMIN = "admin-sentinel-5d1e";
const CURRENT = "current-sentinel-9c4a";
const CREATED = "created-sentinel-77f0";
const BASE = `/client/v4/accounts/${ACCOUNT}/tokens`;

const POLICIES = [
  {
    id: "p1",
    effect: "allow",
    resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
    permission_groups: [{ id: "98d78cd2433d4c3687191bc0244ef948", name: "Workers Admin" }],
  },
  {
    id: "p2",
    effect: "allow",
    resources: { "com.cloudflare.api.account.zone.30b6d5db5827edd602234ec626d4d501": "*" },
    permission_groups: [{ id: "28f4b596e7d643029c524985477ae49a", name: "Workers Routes Write" }],
  },
];

const tokenBody = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: "cicd-keypin",
  status: "active",
  issued_on: "2026-11-10T13:41:23Z",
  expires_on: "2027-02-09T02:59:59Z",
  last_used_on: "2026-11-10T14:54:43Z",
  policies: POLICIES,
  ...extra,
});

type Reply = { status: number; body?: unknown; raw?: string };
const ok = (result: unknown): Reply => ({
  status: 200,
  body: { success: true, errors: [], result },
});

function setup(routes: Record<string, Reply>) {
  const requests: { method: string; path: string; auth: string; body: string }[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    requests.push({
      method: init.method,
      path: url.pathname,
      auth: init.headers.Authorization ?? "",
      body: init.body ?? "",
    });
    const reply = routes[`${init.method} ${url.pathname}`] ?? {
      status: 404,
      body: { success: false, errors: [{ code: 1003, message: "not found" }] },
    };
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status });
  };
  const tokens = new CloudflareAccountTokens({
    account: ACCOUNT,
    admin: new Secret(ADMIN),
    fetch,
  });
  return { tokens, requests };
}

describe("CloudflareAccountTokens", () => {
  test("refuses an account that isn't an ID", () => {
    expect(
      () => new CloudflareAccountTokens({ account: "personal", admin: new Secret(ADMIN) }),
    ).toThrow(`"personal" isn't a Cloudflare account ID`);
  });

  test("verify uses the value itself, not the admin token", async () => {
    const { tokens, requests } = setup({
      [`GET ${BASE}/verify`]: ok({ id: OLD, status: "active", expires_on: "2027-02-09T02:59:59Z" }),
    });
    expect(await tokens.verify(new Secret(CURRENT))).toEqual({
      id: OLD,
      status: "active",
      expiresOn: "2027-02-09T02:59:59Z",
    });
    expect(requests).toEqual([
      { method: "GET", path: `${BASE}/verify`, auth: `Bearer ${CURRENT}`, body: "" },
    ]);
  });

  test("verify fails with the HTTP status and error codes, never the value", async () => {
    const { tokens } = setup({
      [`GET ${BASE}/verify`]: {
        status: 401,
        body: { errors: [{ code: 1000, message: `Invalid API Token ${CURRENT}` }] },
      },
    });
    const error = await tokens.verify(new Secret(CURRENT)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      `GET /accounts/${ACCOUNT}/tokens/verify returned HTTP 401, codes 1000`,
    );
    expect(String(error)).not.toContain(CURRENT);
  });

  test("details reads policies with the admin token, and null when the token is gone", async () => {
    const { tokens, requests } = setup({ [`GET ${BASE}/${OLD}`]: ok(tokenBody(OLD)) });
    const found = await tokens.details(OLD);
    expect(found).toMatchObject({
      id: OLD,
      name: "cicd-keypin",
      status: "active",
      expiresOn: "2027-02-09T02:59:59Z",
      lastUsedOn: "2026-11-10T14:54:43Z",
      condition: null,
    });
    expect(found?.policies.map((p) => p.permissionGroups.map((g) => g.name))).toEqual([
      ["Workers Admin"],
      ["Workers Routes Write"],
    ]);
    expect(requests[0]?.auth).toBe(`Bearer ${ADMIN}`);
    expect(await tokens.details(NEW)).toBeNull();
  });

  test("details refuses a token ID that isn't 32 hex characters, before any request", async () => {
    const { tokens, requests } = setup({});
    await expect(tokens.details("../user")).rejects.toThrow("no valid token ID");
    expect(requests).toEqual([]);
  });

  test("issue copies policies by permission group ID, and the condition, and returns the value as a Secret", async () => {
    const condition = { "request.ip": { in: ["192.0.2.0/24"] } };
    const { tokens, requests } = setup({
      [`GET ${BASE}/${OLD}`]: ok(tokenBody(OLD, { condition })),
      [`POST ${BASE}`]: ok({
        ...tokenBody(NEW, { name: "cicd-keypin 2026-11-10", condition }),
        value: CREATED,
      }),
    });
    const old = await tokens.details(OLD);
    if (!old) throw new Error("no old token");
    const made = await tokens.issue({
      name: "cicd-keypin 2026-11-10",
      like: old,
      expiresOn: "2027-02-22T23:59:59Z",
    });
    if ("refused" in made) throw new Error(made.refused);
    expect(made.token.id).toBe(NEW);
    expect(made.value.reveal()).toBe(CREATED);
    expect(String(made.value)).toBe("[secret]");
    expect(JSON.stringify(made.token)).not.toContain(CREATED);

    const post = requests.find((r) => r.method === "POST");
    expect(post?.auth).toBe(`Bearer ${ADMIN}`);
    expect(JSON.parse(post?.body ?? "")).toEqual({
      name: "cicd-keypin 2026-11-10",
      policies: [
        {
          effect: "allow",
          resources: POLICIES[0]?.resources,
          permission_groups: [{ id: "98d78cd2433d4c3687191bc0244ef948" }],
        },
        {
          effect: "allow",
          resources: POLICIES[1]?.resources,
          permission_groups: [{ id: "28f4b596e7d643029c524985477ae49a" }],
        },
      ],
      expires_on: "2027-02-22T23:59:59Z",
      condition,
    });
  });

  test("issue reports a refusal without throwing, so the caller knows no token was made", async () => {
    const { tokens } = setup({
      [`GET ${BASE}/${OLD}`]: ok(tokenBody(OLD)),
      [`POST ${BASE}`]: { status: 403, body: { errors: [{ code: 9109 }] } },
    });
    const old = await tokens.details(OLD);
    if (!old) throw new Error("no old token");
    expect(await tokens.issue({ name: "x", like: old, expiresOn: "2027-01-01T00:00:00Z" })).toEqual(
      { refused: `Cloudflare POST /accounts/${ACCOUNT}/tokens returned HTTP 403, codes 9109` },
    );
  });

  test.each([
    [502, { raw: "<html>Bad gateway</html>" }],
    [504, { raw: "" }],
    [500, { body: { errors: [{ code: 10000 }] } }],
  ])(
    "issue throws on HTTP %i, because Cloudflare may have made the token anyway",
    async (status, reply) => {
      const { tokens } = setup({
        [`GET ${BASE}/${OLD}`]: ok(tokenBody(OLD)),
        [`POST ${BASE}`]: { status, ...reply },
      });
      const old = await tokens.details(OLD);
      if (!old) throw new Error("no old token");
      await expect(
        tokens.issue({ name: "x", like: old, expiresOn: "2027-01-01T00:00:00Z" }),
      ).rejects.toThrow(`returned HTTP ${status}`);
    },
  );

  test("revoke deletes by ID, and treats 404 as already gone", async () => {
    const { tokens, requests } = setup({ [`DELETE ${BASE}/${OLD}`]: ok({ id: OLD }) });
    expect(await tokens.revoke(OLD)).toBe("revoked");
    expect(await tokens.revoke(NEW)).toBe("already gone");
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `DELETE ${BASE}/${OLD}`,
      `DELETE ${BASE}/${NEW}`,
    ]);
  });

  test("revoke fails on other errors", async () => {
    const { tokens } = setup({ [`DELETE ${BASE}/${OLD}`]: { status: 403, body: {} } });
    await expect(tokens.revoke(OLD)).rejects.toThrow("returned HTTP 403");
  });
});

describe("sameAccess", () => {
  const base: ProviderToken = {
    id: OLD,
    name: "a",
    status: "active",
    expiresOn: null,
    lastUsedOn: null,
    condition: null,
    policies: [
      {
        effect: "allow",
        resources: { a: "*", b: { c: "*" } },
        permissionGroups: [
          { id: "g1", name: "One" },
          { id: "g2", name: "Two" },
        ],
      },
      { effect: "allow", resources: { z: "*" }, permissionGroups: [{ id: "g3", name: "Three" }] },
    ],
  };

  test("ignores order, names, IDs and expiry", () => {
    const [first, second] = base.policies;
    if (!first || !second) throw new Error("fixture");
    const other: ProviderToken = {
      ...base,
      id: NEW,
      name: "b",
      expiresOn: "2027-01-01T00:00:00Z",
      policies: [
        second,
        {
          effect: "allow",
          resources: { b: { c: "*" }, a: "*" },
          permissionGroups: [
            { id: "g2", name: "renamed" },
            { id: "g1", name: "One" },
          ],
        },
      ],
    };
    expect(sameAccess(base, other)).toBe(true);
  });

  test("sees a missing group, a different resource, an effect or a condition", () => {
    const [first, second] = base.policies;
    if (!first || !second) throw new Error("fixture");
    const drop = {
      ...base,
      policies: [{ ...first, permissionGroups: [{ id: "g1", name: "One" }] }, second],
    };
    const zone = { ...base, policies: [first, { ...second, resources: { y: "*" } }] };
    const deny = { ...base, policies: [first, { ...second, effect: "deny" }] };
    const ip = { ...base, condition: { "request.ip": { in: ["192.0.2.0/24"] } } };
    for (const changed of [drop, zone, deny, ip]) expect(sameAccess(base, changed)).toBe(false);
  });
});
