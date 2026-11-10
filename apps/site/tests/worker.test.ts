import { describe, expect, test } from "vite-plus/test";
import worker, { type Env } from "../src/worker";

const assets: Env = {
  ASSETS: { fetch: async (request) => new Response(`asset ${new URL(request.url).pathname}`) },
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
});
