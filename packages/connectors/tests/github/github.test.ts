import sodium from "libsodium-wrappers";
import { assert, beforeAll, describe, expect, test } from "vite-plus/test";
import { type Fetch, isRecord, Secret } from "@keypin/core";
import { GitHubSecretDestination, sealedBox } from "../../src/github/index";
import { expectNoneOf } from "@keypin/core/testing";

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

const expectNoSentinel = (...seen: unknown[]) => expectNoneOf([SENTINEL, TOKEN], ...seen);

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
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /user",
      `GET /repos/${REPO}`,
      `GET /repos/${REPO}/actions/secrets/public-key`,
    ]);
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
    assert(!check.ok);
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
    assert(!check.ok);
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
    assert(!check.ok);
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
    assert(!check.ok);
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
    assert(!check.ok);
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
  let environmentPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  beforeAll(() => {
    environmentPair = sodium.crypto_box_keypair();
  });

  function environmentRoutes(): Routes {
    const routes: Routes = {};
    for (const [route, reply] of Object.entries(happyRoutes()))
      routes[route.replace(`/repos/${REPO}/actions/secrets`, `${ENV}/secrets`)] = reply;
    routes[`GET ${ENV}/secrets/public-key`] = {
      status: 200,
      body: {
        key_id: "env-kid-2",
        key: sodium.to_base64(environmentPair.publicKey, sodium.base64_variants.ORIGINAL),
      },
    };
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
      `GET ${ENV}/secrets/public-key`,
      `GET ${ENV}/secrets/public-key`,
      `PUT ${ENV}/secrets/API_KEY`,
      `GET ${ENV}/secrets/API_KEY`,
    ]);
    expect(requests.some((r) => r.path.includes("/actions/"))).toBe(false);

    const put = requests.find((r) => r.method === "PUT");
    assert(put);
    const body: unknown = JSON.parse(put.body);
    assert(isRecord(body) && typeof body.encrypted_value === "string");
    expect(body.key_id).toBe("env-kid-2");
    const sealed = sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL);
    expect(
      sodium.crypto_box_seal_open(
        sealed,
        environmentPair.publicKey,
        environmentPair.privateKey,
        "text",
      ),
    ).toBe(SENTINEL);
  });

  test("an environment that doesn't exist fails the check, and nothing is written", async () => {
    const routes = environmentRoutes();
    delete routes[`GET ${ENV}/secrets/public-key`];
    const { github, requests } = destination(routes, { environment: "prod/eu" });
    const check = await github.checkAccount();
    expect(check).toMatchObject({ ok: false, destinationAccount: "acme" });
    assert(!check.ok);
    expect(check.reason).toBe(
      `${REPO} has no environment named prod/eu, or acme can't see its secrets`,
    );
    expect(check.fix).toBe(
      "create it in the repository's Settings > Environments, or fix environment in secretspec.toml",
    );
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(/checkAccount/);
    expect(requests.some((r) => r.method !== "GET")).toBe(false);
  });

  test("a fine-grained token refused the environment's secrets is told to add Environments", async () => {
    const routes = environmentRoutes();
    routes[`GET ${ENV}/secrets/public-key`] = {
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
    };
    const check = await destination(routes, { environment: "prod/eu" }).github.checkAccount();
    assert(!check.ok);
    expect(check.fix).toBe(
      "give the token the repository permission Environments: Read and write, or sign gh in with the browser: gh auth login --hostname github.com",
    );
  });

  test("needs only the environment's secrets, not its settings", async () => {
    const routes = environmentRoutes();
    routes[`GET ${ENV}`] = { status: 403, body: { message: "Resource not accessible" } };
    const { github, requests } = destination(routes, { environment: "prod/eu" });
    expect((await github.checkAccount()).ok).toBe(true);
    expect(requests.some((r) => r.path === ENV)).toBe(false);
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
    userDown["GET /user"] = { status: 500, body: { message: "Server Error" } };
    const e1 = await destination(userDown)
      .github.checkAccount()
      .catch((e: unknown) => e);
    expect(e1).toEqual(new Error("GitHub GET /user returned HTTP 500: Server Error"));

    const keyDown = happyRoutes();
    const key = keyDown[`GET /repos/${REPO}/actions/secrets/public-key`];
    let keyAsked = 0;
    keyDown[`GET /repos/${REPO}/actions/secrets/public-key`] = () =>
      keyAsked++ === 0 && key && typeof key !== "function"
        ? key
        : { status: 500, body: { message: `boom ${SENTINEL}` } };
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

describe("refusals that say what to do", () => {
  const KEY = `GET /repos/${REPO}/actions/secrets/public-key`;
  const SSO_URL = "https://github.com/orgs/acme/sso?authorization_request=abc123";

  test("an archived repository fails the check before any write", async () => {
    const routes = happyRoutes();
    routes[`GET /repos/${REPO}`] = {
      status: 200,
      body: { owner: { login: "acme" }, archived: true, permissions: { push: false } },
    };
    const { github, requests } = destination(routes);
    const check = await github.checkAccount();
    expect(check).toMatchObject({ ok: false, destinationAccount: "acme" });
    assert(!check.ok);
    expect(check.reason).toBe(
      "acme/billing is archived, so it's read-only and GitHub won't let anyone set its secrets",
    );
    expect(check.fix).toBe(
      "unarchive it in the repository's Settings, or remove it from secretspec.toml",
    );
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test.each([403, 404])(
    "a token not authorized for SAML SSO (HTTP %i) gets GitHub's link",
    async (status) => {
      const routes = happyRoutes();
      routes[`GET /repos/${REPO}`] = {
        status,
        body: { message: "Resource protected by organization SAML enforcement." },
        headers: { "x-github-sso": `required; url=${SSO_URL}` },
      };
      const check = await destination(routes).github.checkAccount();
      expect(check).toMatchObject({ ok: false, destinationAccount: null });
      assert(!check.ok);
      expect(check.reason).toBe("the gh token isn't authorized for SAML SSO in acme");
      expect(check.fix).toBe(
        `authorize the gh token for SSO in acme: ${SSO_URL} (the link expires in an hour)`,
      );
    },
  );

  test("an SSO refusal on the secrets, after the repository, also says to authorize", async () => {
    const routes = happyRoutes();
    routes[KEY] = {
      status: 403,
      body: { message: "SAML" },
      headers: { "x-github-sso": "required" },
    };
    const check = await destination(routes).github.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("the gh token isn't authorized for SAML SSO in acme");
    expect(check.fix).toBe("authorize the gh token for SSO in acme on github.com");
  });

  test("a fine-grained token without the Secrets permission fails the check, before the y", async () => {
    const routes = happyRoutes();
    routes["GET /user"] = { status: 200, body: { login: "acme" } };
    routes[KEY] = {
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
      headers: { "x-accepted-github-permissions": "secrets=read" },
    };
    const { github, requests } = destination(routes);
    const check = await github.checkAccount();
    expect(check).toMatchObject({ ok: false, destinationAccount: "acme" });
    assert(!check.ok);
    expect(check.reason).toBe(
      "the token can't use acme/billing's Actions secrets (HTTP 403: Resource not accessible by personal access token)",
    );
    expect(check.fix).toBe(
      "give the token the repository permission Secrets: Read and write, or sign gh in with the browser: gh auth login --hostname github.com",
    );
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(/checkAccount/);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test("a refused PUT says what GitHub said, and leaves the value out", async () => {
    const routes = happyRoutes();
    routes[`PUT /repos/${REPO}/actions/secrets/API_KEY`] = {
      status: 403,
      body: { message: "Resource not accessible by integration" },
      headers: { "x-accepted-github-permissions": "secrets=write" },
    };
    const { github } = destination(routes);
    await github.checkAccount();
    const error = await github.write("API_KEY", new Secret(SENTINEL)).catch((e: unknown) => e);
    expect(error).toEqual(
      new Error(
        `GitHub PUT /repos/${REPO}/actions/secrets/API_KEY returned HTTP 403: Resource not accessible by integration; the token needs the permission secrets=write`,
      ),
    );
  });

  test("a value over 48 KB that GitHub refuses says so", async () => {
    const routes = happyRoutes();
    routes[`PUT /repos/${REPO}/actions/secrets/API_KEY`] = {
      status: 422,
      body: { message: "Invalid request." },
    };
    const { github } = destination(routes);
    await github.checkAccount();
    const big = `${SENTINEL}${"x".repeat(50 * 1024 - SENTINEL.length)}`;
    const error = await github.write("API_KEY", new Secret(big)).catch((e: unknown) => e);
    expect(error).toEqual(
      new Error(
        `API_KEY is 50 KB, and GitHub allows at most 48 KB in a secret (GitHub PUT /repos/${REPO}/actions/secrets/API_KEY returned HTTP 422)`,
      ),
    );
    expectNoSentinel(error);
  });

  test("a new secret GitHub refuses when the repository has 100 says so", async () => {
    const routes = happyRoutes();
    routes[`PUT /repos/${REPO}/actions/secrets/API_KEY`] = {
      status: 422,
      body: { message: "Invalid request." },
    };
    delete routes[`GET /repos/${REPO}/actions/secrets/API_KEY`];
    routes[`GET /repos/${REPO}/actions/secrets`] = {
      status: 200,
      body: { total_count: 100, secrets: [] },
    };
    const { github } = destination(routes);
    await github.checkAccount();
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(
      `github ${REPO} (repo secret) already has 100 secrets, and GitHub allows 100; delete one it no longer uses, then publish again (GitHub PUT /repos/${REPO}/actions/secrets/API_KEY returned HTTP 422)`,
    );
  });

  test("a refused PUT under both limits keeps GitHub's own message", async () => {
    const routes = happyRoutes();
    routes[`PUT /repos/${REPO}/actions/secrets/API_KEY`] = {
      status: 422,
      body: { message: "Invalid request." },
    };
    delete routes[`GET /repos/${REPO}/actions/secrets/API_KEY`];
    routes[`GET /repos/${REPO}/actions/secrets`] = {
      status: 200,
      body: { total_count: 3, secrets: [] },
    };
    const { github } = destination(routes);
    await github.checkAccount();
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(
      `GitHub PUT /repos/${REPO}/actions/secrets/API_KEY returned HTTP 422: Invalid request.`,
    );
  });

  test("a refused PUT keeps GitHub's message when checking the limits fails", async () => {
    const routes = happyRoutes();
    routes[`PUT /repos/${REPO}/actions/secrets/API_KEY`] = {
      status: 422,
      body: { message: "Invalid request." },
    };
    routes[`GET /repos/${REPO}/actions/secrets/API_KEY`] = () => {
      throw new TypeError("fetch failed");
    };
    const { github } = destination(routes);
    await github.checkAccount();
    await expect(github.write("API_KEY", new Secret(SENTINEL))).rejects.toThrow(
      `GitHub PUT /repos/${REPO}/actions/secrets/API_KEY returned HTTP 422: Invalid request.`,
    );
  });

  test("an invisible repository mentions that GitHub Enterprise isn't supported", async () => {
    const routes = happyRoutes();
    delete routes[`GET /repos/${REPO}`];
    const check = await destination(routes).github.checkAccount();
    assert(!check.ok);
    expect(check.fix).toBe(
      "check repo in secretspec.toml, or publish as a login that can see it: git config github.account <login> (keypin publishes only to github.com; GitHub Enterprise Server and ghe.com aren't supported yet)",
    );
  });
});
