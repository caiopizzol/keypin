import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, test } from "vite-plus/test";
import { Secret } from "@keypin/core";
import {
  currentWranglerToken,
  type Fetch,
  WorkerSecretDestination,
  wranglerConfigFile,
  wranglerToken,
} from "../src/index";

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

function expectNoSentinel(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain(TOKEN);
}

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

describe("wranglerToken", () => {
  test("reads a valid login, and never puts the token in an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keypin-wrangler-"));
    try {
      const path = join(dir, "default.toml");
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await writeFile(
        path,
        `oauth_token = "${TOKEN}"\nexpiration_time = "${future}"\nrefresh_token = "r"\n`,
      );
      expect(await wranglerToken(path)).toBe(TOKEN);

      await writeFile(path, `refresh_token = "r"\n`);
      const failure = wranglerToken(path);
      await expect(failure).rejects.toThrow(/no oauth_token/);
      expectNoSentinel(await failure.catch((e: unknown) => e));
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("currentWranglerToken", () => {
  test("refuses an expired login instead of refreshing it, without the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keypin-wrangler-"));
    try {
      const path = join(dir, "default.toml");
      const past = new Date(Date.now() - 3_600_000).toISOString();
      await writeFile(path, `oauth_token = "${TOKEN}"\nexpiration_time = "${past}"\n`);
      const failure = currentWranglerToken(path);
      await expect(failure).rejects.toThrow(
        "the wrangler login has expired; run `wrangler whoami`",
      );
      expectNoSentinel(await failure.catch((e: unknown) => e));
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await writeFile(path, `oauth_token = "${TOKEN}"\nexpiration_time = "${future}"\n`);
      expect(await currentWranglerToken(path)).toBe(TOKEN);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("wranglerConfigFile", () => {
  async function withHome(run: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "keypin-home-"));
    try {
      await run(home);
    } finally {
      await rm(home, { recursive: true });
    }
  }

  test("on macOS, uses ~/Library/Preferences/.wrangler, or XDG_CONFIG_HOME when set", () =>
    withHome(async (home) => {
      expect(wranglerConfigFile({}, "darwin", home)).toBe(
        join(home, "Library/Preferences/.wrangler/config/default.toml"),
      );
      expect(wranglerConfigFile({ XDG_CONFIG_HOME: "" }, "darwin", home)).toBe(
        join(home, "Library/Preferences/.wrangler/config/default.toml"),
      );
      const xdg = join(home, "xdg");
      expect(wranglerConfigFile({ XDG_CONFIG_HOME: xdg }, "darwin", home)).toBe(
        join(xdg, ".wrangler/config/default.toml"),
      );
    }));

  test("on Linux, uses ~/.config/.wrangler, or XDG_CONFIG_HOME when set", () =>
    withHome(async (home) => {
      expect(wranglerConfigFile({}, "linux", home)).toBe(
        join(home, ".config/.wrangler/config/default.toml"),
      );
      const xdg = join(home, "xdg");
      expect(wranglerConfigFile({ XDG_CONFIG_HOME: xdg }, "linux", home)).toBe(
        join(xdg, ".wrangler/config/default.toml"),
      );
    }));

  test("a ~/.wrangler folder wins over the XDG path, as in wrangler; a file there doesn't", () =>
    withHome(async (home) => {
      const xdg = { XDG_CONFIG_HOME: join(home, "xdg") };
      await writeFile(join(home, ".wrangler"), "");
      expect(wranglerConfigFile(xdg, "linux", home)).toBe(
        join(home, "xdg/.wrangler/config/default.toml"),
      );
      await rm(join(home, ".wrangler"));
      await mkdir(join(home, ".wrangler"));
      for (const platform of ["darwin", "linux"])
        for (const env of [{}, xdg])
          expect(wranglerConfigFile(env, platform, home)).toBe(
            join(home, ".wrangler/config/default.toml"),
          );
    }));

  test("on Windows, says it isn't supported", () =>
    withHome(async (home) => {
      expect(() => wranglerConfigFile({}, "win32", home)).toThrow(
        "keypin doesn't find the wrangler login on Windows yet",
      );
    }));

  test("the token reads from the resolved Linux path under a throwaway HOME", () =>
    withHome(async (home) => {
      const env = { XDG_CONFIG_HOME: join(home, ".config") };
      const path = wranglerConfigFile(env, "linux", home);
      await mkdir(join(home, ".config/.wrangler/config"), { recursive: true });
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await writeFile(path, `oauth_token = "${TOKEN}"\nexpiration_time = "${future}"\n`);
      expect(await currentWranglerToken(path)).toBe(TOKEN);
    }));
});
