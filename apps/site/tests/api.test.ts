import { describe, expect, test } from "vite-plus/test";
import { type Api, handleApi } from "../src/api";
import { fakeApi, ORIGIN } from "./fakes";

interface Call {
  method?: string;
  token?: string | null;
  origin?: string | null;
  body?: unknown;
  rawBody?: string;
}

function call(
  api: Api,
  path: string,
  { method = "GET", token = "good-token", origin, body, rawBody }: Call = {},
) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const sendOrigin = origin === undefined ? (method === "GET" ? null : ORIGIN) : origin;
  if (sendOrigin) headers.set("origin", sendOrigin);
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  return handleApi(new Request(`${ORIGIN}${path}`, { method, headers, body: payload }), api);
}

const put = (api: Api, body: unknown, extra: Call = {}) =>
  call(api, "/api/signup", { method: "PUT", body, ...extra });

describe("GET /api/config", () => {
  test("returns the publishable key without auth", async () => {
    const response = await call(fakeApi(), "/api/config", { token: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ clerkPublishableKey: "pk_test_fake" });
  });
});

describe("/api/signup auth", () => {
  test("401 without a token", async () => {
    const response = await call(fakeApi(), "/api/signup", { token: null });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Sign in with GitHub first." });
  });

  test("401 with an invalid token", async () => {
    expect((await call(fakeApi(), "/api/signup", { token: "bad" })).status).toBe(401);
    expect((await put(fakeApi(), { use: "solo" }, { token: "bad" })).status).toBe(401);
  });

  test("403 for PUT and DELETE from another origin or none", async () => {
    for (const method of ["PUT", "DELETE"]) {
      for (const origin of ["https://evil.example", null]) {
        const response = await call(fakeApi(), "/api/signup", {
          method,
          origin,
          body: { use: "solo" },
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toHaveProperty("error");
      }
    }
  });

  test("405 for other methods", async () => {
    expect((await call(fakeApi(), "/api/signup", { method: "POST" })).status).toBe(405);
  });
});

describe("PUT /api/signup validation", () => {
  const bad: [string, unknown][] = [
    ["missing use", {}],
    ["unknown use", { use: "company" }],
    ["team without teamSize", { use: "team" }],
    ["team with an unknown size", { use: "team", teamSize: "5" }],
    ["solo with teamSize", { use: "solo", teamSize: "2-10" }],
    ["solo with a null teamSize", { use: "solo", teamSize: null }],
    ["note that isn't text", { use: "solo", note: 5 }],
    ["note over 500 characters", { use: "solo", note: "a".repeat(501) }],
    ["unknown field", { use: "solo", extra: 1 }],
    ["identity in the body", { use: "solo", githubLogin: "someone-else" }],
    ["an array", [{ use: "solo" }]],
  ];
  for (const [name, body] of bad) {
    test(`400 for ${name}`, async () => {
      const response = await put(fakeApi(), body);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    });
  }

  test("400 for a body that isn't JSON", async () => {
    expect((await put(fakeApi(), undefined, { rawBody: "{" })).status).toBe(400);
  });

  test("413 for a body over 4 KB", async () => {
    const response = await put(fakeApi(), undefined, {
      rawBody: JSON.stringify({ use: "solo", note: "a".repeat(5000) }),
    });
    expect(response.status).toBe(413);
  });

  test("trims the note, and a blank note is absent", async () => {
    const api = fakeApi();
    const trimmed = await put(api, { use: "solo", note: `  ${"a".repeat(500)}  ` });
    expect((await trimmed.json()).signup.note).toBe("a".repeat(500));
    const blank = await put(api, { use: "solo", note: "   " });
    expect((await blank.json()).signup.note).toBeNull();
  });
});

describe("PUT, GET and DELETE /api/signup", () => {
  test("GET is null before anything is stored", async () => {
    expect(await (await call(fakeApi(), "/api/signup")).json()).toEqual({ signup: null });
  });

  test("PUT then GET returns the same signup, with identity from Clerk", async () => {
    const api = fakeApi();
    const stored = await put(api, { use: "team", teamSize: "11-50", note: "We use 1Password." });
    expect(stored.status).toBe(200);
    expect(stored.headers.get("cache-control")).toBe("no-store");
    const expected = {
      signup: {
        githubLogin: "octocat",
        email: "octocat@example.com",
        use: "team",
        teamSize: "11-50",
        note: "We use 1Password.",
        createdAt: "2026-11-12T12:00:00.000Z",
        updatedAt: "2026-11-12T12:00:00.000Z",
      },
    };
    expect(await stored.json()).toEqual(expected);
    expect(await (await call(api, "/api/signup")).json()).toEqual(expected);
  });

  test("a second PUT keeps createdAt and moves updatedAt", async () => {
    const api = fakeApi();
    await put(api, { use: "team", teamSize: "2-10" });
    const { signup } = await (await put(api, { use: "solo" })).json();
    expect(signup).toMatchObject({ use: "solo", teamSize: null, note: null });
    expect(signup.createdAt).toBe("2026-11-12T12:00:00.000Z");
    expect(signup.updatedAt).toBe("2026-11-12T12:00:01.000Z");
  });

  test("DELETE returns 204, and GET is null afterwards", async () => {
    const api = fakeApi();
    await put(api, { use: "solo" });
    const deleted = await call(api, "/api/signup", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    expect(await (await call(api, "/api/signup")).json()).toEqual({ signup: null });
  });

  test("DELETE with nothing stored is still 204", async () => {
    expect((await call(fakeApi(), "/api/signup", { method: "DELETE" })).status).toBe(204);
  });

  test("413 for a body over 4 KB with no Content-Length", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ use: "solo", note: "a".repeat(5000) }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big.slice(0, 3000));
        controller.enqueue(big.slice(3000));
        controller.close();
      },
    });
    const headers = new Headers({ authorization: "Bearer good-token", origin: ORIGIN });
    const init: RequestInit & { duplex: "half" } = { method: "PUT", headers, body, duplex: "half" };
    const request = new Request(`${ORIGIN}/api/signup`, init);
    expect(request.headers.get("content-length")).toBeNull();
    expect((await handleApi(request, fakeApi())).status).toBe(413);
  });

  test("500, not 401, when token verification itself fails", async () => {
    const api = fakeApi();
    const logged: unknown[] = [];
    api.log = (_message, cause) => logged.push(cause);
    api.auth.verify = async () => {
      throw new Error("Clerk is unreachable");
    };
    expect((await call(api, "/api/signup")).status).toBe(500);
    expect(logged).toEqual([new Error("Clerk is unreachable")]);
  });

  test("500 with a plain sentence when storage fails", async () => {
    const api = fakeApi();
    api.store.get = async () => {
      throw new Error("D1 is down");
    };
    const response = await call(api, "/api/signup");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Something went wrong on our side. Try again.",
    });
  });
});
