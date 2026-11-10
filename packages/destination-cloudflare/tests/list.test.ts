import { describe, expect, test } from "vite-plus/test";
import { CloudflareReader, type Fetch } from "../src/index";

const TOKEN = "token-sentinel-41b2";
const ACCOUNT = "11111111111111111111111111111111";
const OTHER = "22222222222222222222222222222222";

type Routes = Record<string, { status: number; body?: unknown }>;

function reader(routes: Routes, token: () => Promise<string> = async () => TOKEN) {
  const requests: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push(`${init.method} ${path}`);
    const reply = routes[path] ?? { status: 404, body: { success: false } };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  };
  return { reader: new CloudflareReader({ token, fetch }), requests };
}

const ACCOUNTS = {
  "/client/v4/accounts": {
    status: 200,
    body: { result: [{ id: ACCOUNT }], result_info: { total_pages: 1 } },
  },
};

describe("CloudflareReader", () => {
  test("lists a Worker's secret names, after checking the login reaches the account", async () => {
    const { reader: cf, requests } = reader({
      ...ACCOUNTS,
      [`/client/v4/accounts/${ACCOUNT}/workers/scripts/billing/secrets`]: {
        status: 200,
        body: { result: [{ name: "STRIPE_KEY", type: "secret_text" }] },
      },
    });
    expect(await cf.listWorkerSecrets(ACCOUNT, "billing")).toEqual({
      ok: true,
      secrets: [{ name: "STRIPE_KEY", updatedAt: null }],
    });
    await cf.listWorkerSecrets(ACCOUNT, "billing");
    expect(requests).toEqual([
      "GET /client/v4/accounts",
      `GET /client/v4/accounts/${ACCOUNT}/workers/scripts/billing/secrets`,
      `GET /client/v4/accounts/${ACCOUNT}/workers/scripts/billing/secrets`,
    ]);
  });

  test("a login that reaches another account is a reason, and nothing else is read", async () => {
    const { reader: cf, requests } = reader(ACCOUNTS);
    expect(await cf.listWorkerSecrets(OTHER, "billing")).toEqual({
      ok: false,
      reason: `the wrangler login reaches ${ACCOUNT}, not ${OTHER}`,
    });
    expect(requests).toEqual(["GET /client/v4/accounts"]);
  });

  test("a missing Worker, a refusal and no login are reasons, without the token", async () => {
    const missing = await reader(ACCOUNTS).reader.listWorkerSecrets(ACCOUNT, "gone");
    expect(missing).toEqual({ ok: false, reason: `account ${ACCOUNT} has no Worker named gone` });
    const refused = await reader({
      "/client/v4/accounts": { status: 403, body: { errors: [{ message: TOKEN }] } },
    }).reader.listWorkerSecrets(ACCOUNT, "billing");
    expect(refused).toEqual({ ok: false, reason: "Cloudflare GET /accounts returned HTTP 403" });
    const noLogin = await reader({}, async () => {
      throw new Error("no wrangler login");
    }).reader.listWorkerSecrets(ACCOUNT, "billing");
    expect(noLogin).toEqual({ ok: false, reason: "no wrangler login" });
    expect(JSON.stringify([missing, refused, noLogin])).not.toContain(TOKEN);
  });
});
