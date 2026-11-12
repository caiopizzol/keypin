import { describe, expect, test } from "vite-plus/test";
import type { D1 } from "../src/store";
import worker, { type Env } from "../src/worker";

const unusedDb: D1 = {
  prepare() {
    throw new Error("The database isn't used here.");
  },
};

const assets: Env = {
  ASSETS: { fetch: async (request) => new Response(`asset ${new URL(request.url).pathname}`) },
  DB: unusedDb,
  CLERK_PUBLISHABLE_KEY: "pk_test_fake",
  CLERK_SECRET_KEY: "sk_test_fake",
  SITE_ORIGIN: "https://keypin.dev",
};

describe("keypin-site worker", () => {
  test("sends www to the apex with a permanent redirect, keeping path and query", async () => {
    const response = await worker.fetch(new Request("https://www.keypin.dev/a?b=1"), assets);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://keypin.dev/a?b=1");
  });

  test("sends plain HTTP to HTTPS on the apex", async () => {
    const response = await worker.fetch(new Request("http://keypin.dev/x"), assets);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://keypin.dev/x");
  });

  test("sends plain HTTP on www to HTTPS on the apex", async () => {
    const response = await worker.fetch(new Request("http://www.keypin.dev/"), assets);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://keypin.dev/");
  });

  test("serves the apex from the static assets", async () => {
    const response = await worker.fetch(new Request("https://keypin.dev/"), assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset /");
  });

  test("serves /api/config from the API", async () => {
    const response = await worker.fetch(new Request("https://keypin.dev/api/config"), assets);
    expect(await response.json()).toEqual({ clerkPublishableKey: "pk_test_fake" });
  });

  test("answers /api/signup without a token with 401, before calling Clerk", async () => {
    const response = await worker.fetch(new Request("https://keypin.dev/api/signup"), assets);
    expect(response.status).toBe(401);
  });

  test("leaves other /api paths to the static assets", async () => {
    const response = await worker.fetch(new Request("https://keypin.dev/api/other"), assets);
    expect(await response.text()).toBe("asset /api/other");
  });
});
