import sodium from "libsodium-wrappers";
import { assert, beforeAll, describe, expect, test } from "vite-plus/test";
import { isRecord, Secret } from "@keypin/core";
import { type Fetch, GitHubSecretDestination, sealedBox } from "../src/index";

const SENTINEL = "sentinel-value-7f3a9c";
const TOKEN = "token-sentinel-41b2";
const REPO = "acme/billing";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Routes = Record<string, Reply | (() => Reply)>;

let keyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
beforeAll(async () => {
  await sodium.ready;
  keyPair = sodium.crypto_box_keypair();
});

const publicKey = () => sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);

function happyRoutes(): Routes {
  return {
    "GET /user": {
      status: 200,
      body: { login: "acme" },
      headers: { "x-oauth-scopes": "gist, read:org, repo" },
    },
    [`GET /repos/${REPO}`]: {
      status: 200,
      body: { owner: { login: "acme" }, permissions: { admin: true, push: true } },
    },
    [`GET /repos/${REPO}/actions/secrets/public-key`]: {
      status: 200,
      body: { key_id: "kid-1", key: publicKey() },
    },
    [`PUT /repos/${REPO}/actions/secrets/API_KEY`]: { status: 201 },
    [`GET /repos/${REPO}/actions/secrets/API_KEY`]: {
      status: 200,
      body: {
        name: "API_KEY",
        created_at: "2026-11-09T18:00:00Z",
        updated_at: "2026-11-09T18:00:00Z",
      },
    },
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
    const route = routes[`${method} ${url.pathname}`];
    const reply =
      typeof route === "function"
        ? route()
        : (route ?? { status: 404, body: { message: "Not Found" } });
    const body = reply.body === undefined ? null : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status, headers: reply.headers });
  };
  return { fetch, requests };
}

function destination(
  routes: Routes,
  options: { login?: string | null; environment?: string } = {},
) {
  const fake = fakeFetch(routes);
  const github = new GitHubSecretDestination({
    repo: REPO,
    token: async () => TOKEN,
    fetch: fake.fetch,
    ...options,
  });
  return { github, requests: fake.requests };
}

function expectNoSentinel(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain(TOKEN);
}

describe("sealed box", () => {
  test("round-trips with a fixed key pair", async () => {
    const encrypted = await sealedBox(SENTINEL, publicKey());
    expect(encrypted).not.toContain(SENTINEL);
    const ciphertext = sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL);
    const plain = sodium.crypto_box_seal_open(
      ciphertext,
      keyPair.publicKey,
      keyPair.privateKey,
      "text",
    );
    expect(plain).toBe(SENTINEL);
  });
});

describe("checkAccount", () => {
  test("passes when the owner, write access and scope match", async () => {
    const { github, requests } = destination(happyRoutes());
    const check = await github.checkAccount();
    expect(check).toEqual({
      publisher: "acme",
      destinationAccount: "acme",
      expected: "acme",
      ok: true,
    });
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(requests[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("a wrong owner fails, and write then refuses", async () => {
    const routes = happyRoutes();
    routes[`GET /repos/${REPO}`] = {
      status: 200,
      body: { owner: { login: "someone-else" }, permissions: { push: true } },
    };
    const { github, requests } = destination(routes);
    const check = await github.checkAccount();
    expect(check.ok).toBe(false);
    expect(check.destinationAccount).toBe("someone-else");
    expect(check.reason).toContain("someone-else");
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(
      /checkAccount hasn't passed/,
    );
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test("an organization teammate with write access, not admin, passes as themselves", async () => {
    const routes = happyRoutes();
    routes["GET /user"] = {
      status: 200,
      body: { login: "alice" },
      headers: { "x-oauth-scopes": "repo" },
    };
    routes[`GET /repos/${REPO}`] = {
      status: 200,
      body: {
        owner: { login: "acme" },
        permissions: { admin: false, maintain: false, push: true },
      },
    };
    const { github } = destination(routes, { login: "alice" });
    expect(await github.checkAccount()).toEqual({
      publisher: "alice",
      destinationAccount: "acme",
      expected: "acme",
      ok: true,
    });
    await github.write("API_KEY", new Secret(SENTINEL));
  });

  test("a personal repo published as its owner from git config passes, as before", async () => {
    const check = await destination(happyRoutes(), { login: "acme" }).github.checkAccount();
    expect(check).toEqual({
      publisher: "acme",
      destinationAccount: "acme",
      expected: "acme",
      ok: true,
    });
  });

  test("a token for another login than the chosen one fails", async () => {
    const routes = happyRoutes();
    routes["GET /user"] = {
      status: 200,
      body: { login: "acme-ops" },
      headers: { "x-oauth-scopes": "repo" },
    };
    const check = await destination(routes, { login: "alice" }).github.checkAccount();
    expect(check).toMatchObject({ publisher: "acme-ops", expected: "acme", ok: false });
    expect(check.reason).toBe("the token acts as acme-ops, not alice");
    expect(check.fix).toBe(
      "run gh auth login --hostname github.com and sign in as alice, or change git config github.account",
    );
  });

  test("with no chosen login, any publisher with write access passes", async () => {
    const routes = happyRoutes();
    routes["GET /user"] = {
      status: 200,
      body: { login: "acme-ops" },
      headers: { "x-oauth-scopes": "repo" },
    };
    const check = await destination(routes, { login: null }).github.checkAccount();
    expect(check).toMatchObject({ publisher: "acme-ops", destinationAccount: "acme", ok: true });
  });

  test("read or triage access fails, and write then refuses", async () => {
    const readOnly = happyRoutes();
    readOnly[`GET /repos/${REPO}`] = {
      status: 200,
      body: { owner: { login: "acme" }, permissions: { admin: false, push: false, pull: true } },
    };
    const { github, requests } = destination(readOnly);
    const check = await github.checkAccount();
    expect(check).toMatchObject({ publisher: "acme", destinationAccount: "acme", ok: false });
    expect(check.reason).toBe(
      "acme has no write access to acme/billing, so GitHub won't let it set Actions secrets",
    );
    expect(check.fix).toBe(
      "ask an admin of acme for the Write role, or publish as another login: git config github.account <login>",
    );
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(/checkAccount/);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test("without the repo scope it fails", async () => {
    const noScope = happyRoutes();
    noScope["GET /user"] = {
      status: 200,
      body: { login: "acme" },
      headers: { "x-oauth-scopes": "gist" },
    };
    const check = await destination(noScope).github.checkAccount();
    expect(check.reason).toBe("the token lacks the repo scope (it has: gist)");
    expect(check.fix).toBe("run gh auth refresh --hostname github.com --scopes repo");
  });

  test("a chosen login without the repo scope is told to switch to it before refreshing", async () => {
    const noScope = happyRoutes();
    noScope["GET /user"] = {
      status: 200,
      body: { login: "acme" },
      headers: { "x-oauth-scopes": "gist" },
    };
    const check = await destination(noScope, { login: "acme" }).github.checkAccount();
    expect(check.reason).toBe("the token lacks the repo scope (it has: gist)");
    expect(check.fix).toBe(
      "run gh auth switch --hostname github.com --user acme, then gh auth refresh --hostname github.com --scopes repo, then switch back to your usual login",
    );
  });

  test("a refused token names the login and how to refresh it, and write then refuses", async () => {
    const routes = happyRoutes();
    routes["GET /user"] = { status: 401, body: { message: "Bad credentials" } };
    const { github, requests } = destination(routes, { login: "alice" });
    await expect(github.checkAccount()).rejects.toThrow(
      "GitHub refused the token for alice (HTTP 401): the login expired or was revoked; run gh auth status to refresh it, or gh auth login --hostname github.com",
    );
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(/checkAccount/);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /user"]);
  });

  test("an invisible repo fails with no destination account", async () => {
    const routes = happyRoutes();
    delete routes[`GET /repos/${REPO}`];
    const check = await destination(routes).github.checkAccount();
    expect(check).toMatchObject({ destinationAccount: null, ok: false });
  });

  test("a check that fails after one that passed turns write off again", async () => {
    let owner = "acme";
    const routes = happyRoutes();
    routes[`GET /repos/${REPO}`] = () => ({
      status: 200,
      body: { owner: { login: owner }, permissions: { push: true } },
    });
    const { github } = destination(routes);
    expect((await github.checkAccount()).ok).toBe(true);
    owner = "someone-else";
    expect((await github.checkAccount()).ok).toBe(false);
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(/checkAccount/);
  });
});

describe("write", () => {
  test("PUTs a sealed box with the key ID and returns updated_at", async () => {
    const { github, requests } = destination(happyRoutes());
    await github.checkAccount();
    const evidence = await github.write("API_KEY", new Secret(SENTINEL));
    expect(evidence).toEqual({
      destination: `github ${REPO} (repo secret)`,
      secret: "API_KEY",
      created: true,
      updatedAt: "2026-11-09T18:00:00Z",
    });

    const put = requests.find((r) => r.method === "PUT");
    assert(put);
    expect(put.body).not.toContain(SENTINEL);
    const body: unknown = JSON.parse(put.body);
    assert(isRecord(body) && typeof body.encrypted_value === "string");
    expect(Object.keys(body).sort()).toEqual(["encrypted_value", "key_id"]);
    expect(body.key_id).toBe("kid-1");
    const ciphertext = sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL);
    expect(
      sodium.crypto_box_seal_open(ciphertext, keyPair.publicKey, keyPair.privateKey, "text"),
    ).toBe(SENTINEL);
    expectNoSentinel(evidence, github.describe());
  });

  test("rejects names GitHub doesn't allow", async () => {
    const { github } = destination(happyRoutes());
    await github.checkAccount();
    await expect(github.write("GITHUB_TOKEN", new Secret(SENTINEL))).rejects.toThrow(
      /valid GitHub secret name/,
    );
    await expect(github.write("1BAD", new Secret(SENTINEL))).rejects.toThrow(
      /valid GitHub secret name/,
    );
  });
});

describe("an environment secret", () => {
  const ENV = `/repos/${REPO}/environments/prod%2Feu`;
  function environmentRoutes(): Routes {
    const routes: Routes = {};
    for (const [route, reply] of Object.entries(happyRoutes()))
      routes[route.replace(`/repos/${REPO}/actions/secrets`, `${ENV}/secrets`)] = reply;
    routes[`GET ${ENV}`] = { status: 200, body: { name: "prod/eu" } };
    return routes;
  }

  test("writes to the environment, sealed with the environment's key", async () => {
    const { github, requests } = destination(environmentRoutes(), { environment: "prod/eu" });
    expect((await github.checkAccount()).ok).toBe(true);
    const evidence = await github.write("API_KEY", new Secret(SENTINEL));
    expect(evidence).toMatchObject({
      destination: `github ${REPO} (secret of the environment prod/eu)`,
      created: true,
    });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /user",
      `GET /repos/${REPO}`,
      `GET ${ENV}`,
      `GET ${ENV}/secrets/public-key`,
      `PUT ${ENV}/secrets/API_KEY`,
      `GET ${ENV}/secrets/API_KEY`,
    ]);
    expect(requests.some((r) => r.path.includes("/actions/secrets"))).toBe(false);
  });

  test("an environment that doesn't exist fails the check, and nothing is written", async () => {
    const routes = environmentRoutes();
    delete routes[`GET ${ENV}`];
    const { github, requests } = destination(routes, { environment: "prod/eu" });
    const check = await github.checkAccount();
    expect(check).toMatchObject({ ok: false, destinationAccount: "acme" });
    expect(check.reason).toBe(`${REPO} has no environment named prod/eu`);
    expect(check.fix).toBe(
      "create it in the repository's Settings > Environments, or fix environment in keypin.toml",
    );
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(/checkAccount/);
    expect(requests.some((r) => r.method !== "GET")).toBe(false);
  });
});

describe("no value or token in any output", () => {
  test("a 500 on the PUT", async () => {
    const routes = happyRoutes();
    routes[`PUT /repos/${REPO}/actions/secrets/API_KEY`] = {
      status: 500,
      body: { message: `boom ${SENTINEL}` },
    };
    const { github } = destination(routes);
    const check = await github.checkAccount();
    const failure = github.write("API_KEY", new Secret(SENTINEL));
    await expect(failure).rejects.toThrow(/HTTP 500/);
    expectNoSentinel(await failure.catch((e: unknown) => e), check, github.describe());
  });

  test("a 500 on /user, a 500 on the public key, and a missing secret after the write", async () => {
    const userDown = happyRoutes();
    userDown["GET /user"] = { status: 500, body: { message: SENTINEL } };
    const e1 = await destination(userDown)
      .github.checkAccount()
      .catch((e: unknown) => e);

    const keyDown = happyRoutes();
    keyDown[`GET /repos/${REPO}/actions/secrets/public-key`] = { status: 500 };
    const d2 = destination(keyDown).github;
    await d2.checkAccount();
    const e2 = await d2.write("API_KEY", new Secret(SENTINEL)).catch((e: unknown) => e);

    const gone = happyRoutes();
    delete gone[`GET /repos/${REPO}/actions/secrets/API_KEY`];
    const d3 = destination(gone).github;
    await d3.checkAccount();
    const e3 = await d3.write("API_KEY", new Secret(SENTINEL)).catch((e: unknown) => e);

    for (const e of [e1, e2, e3]) expect(e).toBeInstanceOf(Error);
    expectNoSentinel(e1, e2, e3);
  });

  test("the secret prints as [secret]", () => {
    const secret = new Secret(SENTINEL);
    expectNoSentinel(String(secret), JSON.stringify({ secret }));
  });
});
