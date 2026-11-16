import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, Secret } from "@keypin/core";
import { WorkerSecretDestination } from "../../src/cloudflare/index";
import { expectNoneOf } from "@keypin/core/testing";

const SENTINEL = "sentinel-value-7f3a9c";
const TOKEN = "token-sentinel-41b2";
const ACCOUNT = "11111111111111111111111111111111";
const OTHER = "22222222222222222222222222222222";
const WORKER = "billing-worker";
const BASE = `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;

type Reply = { status: number; body?: unknown };
type Routes = Record<string, Reply>;

const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { success: true, errors: [], result, ...extra },
});

function happyRoutes(): Routes {
  return {
    "GET /client/v4/user": ok({ id: "u1", email: "me@example.com" }),
    "GET /client/v4/accounts": ok([{ id: ACCOUNT, name: "personal" }], {
      result_info: { page: 1, total_pages: 1 },
    }),
    [`GET ${BASE}/settings`]: ok({ logpush: false }),
    [`PUT ${BASE}/secrets`]: ok({ name: "API_KEY", type: "secret_text" }),
    [`GET ${BASE}/versions`]: ok({
      items: [
        { id: "v-old", metadata: { created_on: "2026-10-24T00:00:00Z" }, annotations: {} },
        {
          id: "v-new",
          metadata: { created_on: "2026-11-09T18:00:00Z" },
          annotations: { "workers/triggered_by": "secret" },
        },
      ],
    }),
  };
}

function fakeFetch(routes: Routes) {
  const requests: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    const method = init.method;
    requests.push({ method, path: url.pathname, headers: init.headers, body: init.body ?? "" });
    const reply = routes[`${method} ${url.pathname}`] ?? {
      status: 404,
      body: { success: false, errors: [{ code: 10007, message: "not found" }] },
    };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
    });
  };
  return { fetch, requests };
}

function destination(routes: Routes, account = ACCOUNT) {
  const fake = fakeFetch(routes);
  const worker = new WorkerSecretDestination({
    account,
    worker: WORKER,
    token: async () => TOKEN,
    fetch: fake.fetch,
  });
  return { worker, requests: fake.requests };
}

const expectNoSentinel = (...seen: unknown[]) => expectNoneOf([SENTINEL, TOKEN], ...seen);

describe("checkAccount", () => {
  test("passes when the account is listed and the Worker exists", async () => {
    const { worker, requests } = destination(happyRoutes());
    expect(await worker.checkAccount()).toEqual({
      publisher: "me@example.com",
      destinationAccount: ACCOUNT,
      expected: ACCOUNT,
      ok: true,
    });
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(requests[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("an account not in /accounts fails, and write then refuses", async () => {
    const { worker, requests } = destination(happyRoutes(), OTHER);
    const check = await worker.checkAccount();
    expect(check).toMatchObject({ expected: OTHER, destinationAccount: null, ok: false });
    expect(check.reason).toContain(ACCOUNT);
    await expect(worker.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(
      /checkAccount hasn't passed/,
    );
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test("a missing Worker fails", async () => {
    const routes = happyRoutes();
    delete routes[`GET ${BASE}/settings`];
    const { worker, requests } = destination(routes);
    const check = await worker.checkAccount();
    expect(check).toMatchObject({ destinationAccount: null, ok: false });
    expect(check.reason).toContain(`no Worker ${WORKER}`);
    expect(check.fix).toContain("dispatch namespace");
    await expect(worker.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(/checkAccount/);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test("reads every page of /accounts", async () => {
    const routes = happyRoutes();
    let page = 0;
    const pages = [[{ id: OTHER }], [{ id: ACCOUNT }]];
    const fake = fakeFetch(routes);
    const fetch: Fetch = async (input, init) => {
      if (new URL(input).pathname === "/client/v4/accounts") {
        const reply = ok(pages[page++], { result_info: { page, total_pages: 2 } });
        return new Response(JSON.stringify(reply.body), { status: 200 });
      }
      return fake.fetch(input, init);
    };
    const worker = new WorkerSecretDestination({
      account: ACCOUNT,
      worker: WORKER,
      token: async () => TOKEN,
      fetch,
    });
    expect((await worker.checkAccount()).ok).toBe(true);
    expect(page).toBe(2);
  });

  test("a token scoped to the account, which /accounts refuses, passes on the Worker's settings", async () => {
    for (const status of [401, 403]) {
      const routes = happyRoutes();
      routes["GET /client/v4/accounts"] = {
        status,
        body: { success: false, errors: [{ code: 9109, message: "Unauthorized" }] },
      };
      const { worker, requests } = destination(routes);
      expect(await worker.checkAccount()).toMatchObject({ destinationAccount: ACCOUNT, ok: true });
      expect(requests.map((r) => r.path)).toContain(`${BASE}/settings`);
      await worker.write("API_KEY", new Secret(SENTINEL));
      expect(requests.some((r) => r.method === "PUT")).toBe(true);
    }
  });

  test("a token that can list no accounts and can't read the Worker fails, without writing", async () => {
    const routes = happyRoutes();
    routes["GET /client/v4/accounts"] = { status: 403, body: { success: false } };
    routes[`GET ${BASE}/settings`] = { status: 403, body: { success: false } };
    const { worker, requests } = destination(routes);
    const check = await worker.checkAccount();
    expect(check).toMatchObject({ destinationAccount: null, ok: false });
    expect(check.reason).toBe(
      `the login can't list its accounts or read the Worker ${WORKER} in account ${ACCOUNT}`,
    );
    await expect(worker.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(/checkAccount/);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test("a token that can't read /user still checks, with a label as publisher", async () => {
    const routes = happyRoutes();
    routes["GET /client/v4/user"] = {
      status: 403,
      body: { success: false, errors: [{ code: 9109 }] },
    };
    const check = await destination(routes).worker.checkAccount();
    expect(check).toMatchObject({ publisher: "unknown (the token can't read /user)", ok: true });
  });
});

describe("write", () => {
  test("PUTs { name, text, type } and returns the newest version", async () => {
    const { worker, requests } = destination(happyRoutes());
    await worker.checkAccount();
    const evidence = await worker.write("API_KEY", new Secret(SENTINEL));

    const put = requests.find((r) => r.method === "PUT");
    assert(put);
    expect(put.path).toBe(`${BASE}/secrets`);
    expect(JSON.parse(put.body)).toEqual({ name: "API_KEY", text: SENTINEL, type: "secret_text" });
    expect(evidence).toMatchObject({
      secret: "API_KEY",
      versionId: "v-new",
      createdOn: "2026-11-09T18:00:00Z",
      triggeredBySecret: true,
    });
    expect(evidence.note).toMatch(/all of its secrets/);
    expectNoSentinel(evidence, worker.describe());
  });

  test("a new secret answers HTTP 201, and write still returns the newest version", async () => {
    const routes = happyRoutes();
    routes[`PUT ${BASE}/secrets`] = {
      status: 201,
      body: { success: true, errors: [], result: { name: "NEW_KEY", type: "secret_text" } },
    };
    const { worker } = destination(routes);
    await worker.checkAccount();
    const evidence = await worker.write("NEW_KEY", new Secret(SENTINEL));
    expect(evidence).toMatchObject({ secret: "NEW_KEY", versionId: "v-new" });
  });
});

describe("writeMany", () => {
  test("PATCHes secrets-bulk once, so the keys land in one version", async () => {
    const routes = happyRoutes();
    routes[`PATCH ${BASE}/secrets-bulk`] = ok({});
    const { worker, requests } = destination(routes);
    await worker.checkAccount();
    const evidence = await worker.writeMany([
      { name: "API_KEY", secret: new Secret(SENTINEL) },
      { name: "OTHER_KEY", secret: new Secret(`${SENTINEL}-2`) },
    ]);
    const writes = requests.filter((r) => r.method !== "GET");
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([`PATCH ${BASE}/secrets-bulk`]);
    expect(writes[0]?.headers["Content-Type"]).toBe("application/merge-patch+json");
    expect(JSON.parse(writes[0]?.body ?? "")).toEqual({
      secrets: {
        API_KEY: { name: "API_KEY", text: SENTINEL, type: "secret_text" },
        OTHER_KEY: { name: "OTHER_KEY", text: `${SENTINEL}-2`, type: "secret_text" },
      },
    });
    expect(evidence).toMatchObject({ secret: "API_KEY, OTHER_KEY", versionId: "v-new" });
  });

  test("a failed PATCH hides every value", async () => {
    const routes = happyRoutes();
    routes[`PATCH ${BASE}/secrets-bulk`] = {
      status: 500,
      body: { success: false, errors: [{ code: 10013, message: `bad ${SENTINEL}-2` }] },
    };
    const { worker } = destination(routes);
    await worker.checkAccount();
    const error = await worker
      .writeMany([
        { name: "API_KEY", secret: new Secret(SENTINEL) },
        { name: "OTHER_KEY", secret: new Secret(`${SENTINEL}-2`) },
      ])
      .catch((e: unknown) => e);
    assert(error instanceof Error);
    expect(error.message).toContain("PATCH");
    expectNoSentinel(error);
  });
});

describe("a failed write says why", () => {
  async function failedPut(reply: Reply) {
    const routes = happyRoutes();
    routes[`PUT ${BASE}/secrets`] = reply;
    const { worker } = destination(routes);
    await worker.checkAccount();
    return String(await worker.write("API_KEY", new Secret(SENTINEL)).catch((e: unknown) => e));
  }
  const PATH = `Cloudflare PUT ${BASE.replace("/client/v4", "")}/secrets`;

  test("never shows a message that holds the value or the token", async () => {
    const message = await failedPut({
      status: 400,
      body: {
        success: false,
        errors: [
          { code: 1, message: `bad ${SENTINEL}` },
          { code: 2, message: `bad ${TOKEN}` },
          { code: 3, message: "kept" },
        ],
      },
    });
    expect(message).toBe(`Error: ${PATH} returned HTTP 400, codes 1, 2, 3, "kept"`);
  });

  test("keeps Cloudflare's own message with the code", async () => {
    const message = await failedPut({
      status: 400,
      body: {
        success: false,
        errors: [{ code: 10021, message: "Too many variables for this Worker" }],
      },
    });
    expect(message).toBe(
      `Error: ${PATH} returned HTTP 400, codes 10021, "Too many variables for this Worker"`,
    );
  });

  test.each([10215, 10214])("code %i says to deploy the latest version first", async (code) => {
    const message = await failedPut({
      status: 400,
      body: {
        success: false,
        errors: [{ code, message: "latest version isn't currently deployed" }],
      },
    });
    expect(message).toContain(
      "the Worker's latest version isn't deployed, and writing a secret would deploy it; deploy the latest version first (wrangler versions deploy), or set the secret on a new version with wrangler versions secret put",
    );
    expect(message).toContain(`(${PATH} returned HTTP 400, codes ${code}`);
  });

  test.each([
    [401, "Cloudflare refused the sign-in"],
    [403, "it needs Workers Scripts Edit on the account"],
    [429, "wait a few minutes and run it again"],
  ])("HTTP %i is explained", async (status, says) => {
    const message = await failedPut({ status, body: { success: false, errors: [] } });
    expect(message).toContain(says);
    expect(message).toContain(`(${PATH} returned HTTP ${status})`);
  });
});

describe("no value or token in any output", () => {
  test("a 500 on the PUT whose body echoes the value", async () => {
    const routes = happyRoutes();
    routes[`PUT ${BASE}/secrets`] = {
      status: 500,
      body: { success: false, errors: [{ code: 10013, message: `bad ${SENTINEL}` }] },
    };
    const { worker } = destination(routes);
    const check = await worker.checkAccount();
    const failure = worker.write("API_KEY", new Secret(SENTINEL));
    await expect(failure).rejects.toThrow(
      new Error(
        `Cloudflare PUT ${BASE.replace("/client/v4", "")}/secrets returned HTTP 500, codes 10013`,
      ),
    );
    expectNoSentinel(await failure.catch((e: unknown) => e), check, worker.describe());
  });

  test.each([
    ["ends in a newline, and the message echoes it", `${SENTINEL}\n`, `bad ${SENTINEL}\n`],
    [
      "ends in a newline, and the message echoes it without one",
      `${SENTINEL}\n`,
      `bad ${SENTINEL}`,
    ],
    ["has spaces around it, and the message echoes it", `  ${SENTINEL}  `, `bad ${SENTINEL}`],
  ])("a value that %s isn't shown", async (_, value, message) => {
    const routes = happyRoutes();
    routes[`PUT ${BASE}/secrets`] = {
      status: 500,
      body: { success: false, errors: [{ code: 10013, message }] },
    };
    const { worker } = destination(routes);
    const check = await worker.checkAccount();
    const failure = await worker.write("API_KEY", new Secret(value)).catch((e: unknown) => e);
    assert(failure instanceof Error);
    expect(failure.message).not.toContain("bad");
    expectNoSentinel(failure, check, worker.describe());
  });

  test("a 500 on /accounts and on the versions list", async () => {
    const accountsDown = happyRoutes();
    accountsDown["GET /client/v4/accounts"] = {
      status: 500,
      body: { errors: [{ code: 1, message: SENTINEL }] },
    };
    const e1 = await destination(accountsDown)
      .worker.checkAccount()
      .catch((e: unknown) => e);

    const versionsDown = happyRoutes();
    versionsDown[`GET ${BASE}/versions`] = { status: 500 };
    const d2 = destination(versionsDown).worker;
    await d2.checkAccount();
    const e2 = await d2.write("API_KEY", new Secret(SENTINEL)).catch((e: unknown) => e);

    for (const e of [e1, e2]) expect(e).toBeInstanceOf(Error);
    expectNoSentinel(e1, e2);
  });
});
