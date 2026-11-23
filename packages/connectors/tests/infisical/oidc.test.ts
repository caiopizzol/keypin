import { describe, expect, test } from "vite-plus/test";
import { type Fetch, type IdToken, isRecord, NoIdToken, Secret, SignInFailed } from "@keypin/core";
import { credentialsFrom, infisicalBackend, type InfisicalRef } from "../../src/infisical/index";
import {
  type FakeInfisical,
  infisicalFetch,
  memoryStore,
  OIDC_ACCESS_TOKEN,
} from "../../src/infisical/testing";

const IDENTITY = "4f1a9b2c-0000-4000-8000-000000000001";
const JWT = "github-jwt-sentinel-8d3e";
const REQUEST_TOKEN = "github-request-token-sentinel-2b9a";
const REQUEST_URL = "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0";
const SENTINEL = "sentinel-value-6a1f";
const SECRETS = [JWT, REQUEST_TOKEN, OIDC_ACCESS_TOKEN];

const REF: InfisicalRef = {
  kind: "infisical",
  url: "https://app.infisical.com",
  organization: "acme",
  project: "billing",
  environment: "prod",
  path: "/",
  name: "STRIPE_KEY",
};

const JOB = {
  KEYPIN_INFISICAL_IDENTITY_ID: IDENTITY,
  ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
};

const NO_JOB =
  "this job can't ask GitHub Actions for an OIDC token (ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN aren't set); give it permissions: id-token: write";

function jobToken(env: Record<string, string>, fetch: Fetch): IdToken {
  return async (audience) => {
    if (!env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new NoIdToken(NO_JOB);
    const asked = new URL(REQUEST_URL);
    if (audience !== null) asked.searchParams.set("audience", audience);
    const response = await fetch(asked.href, {
      method: "GET",
      headers: { Authorization: `bearer ${REQUEST_TOKEN}` },
      redirect: "error",
    });
    if (response.status !== 200)
      throw new Error(`GitHub's OIDC token endpoint returned HTTP ${response.status}`);
    return JWT;
  };
}

function setup(
  options: {
    env?: Record<string, string>;
    oidc?: Partial<NonNullable<FakeInfisical["oidc"]>>;
    organization?: string;
    github?: number;
    revoke?: number;
    echo?: boolean;
    echoAfterSignIn?: string;
    dropRevoke?: number;
  } = {},
) {
  const env = { ...JOB, ...options.env };
  const fake: FakeInfisical = {
    organization: options.organization ?? "acme",
    projects: { billing: { prod: { STRIPE_KEY: { value: SENTINEL } } } },
    oidc: { identityId: IDENTITY, jwt: JWT, ...options.oidc },
  };
  const infisical = infisicalFetch(fake, memoryStore());
  const calls: { call: string; redirect: string | undefined; body: unknown }[] = [];
  const fetch: Fetch = (url, init) => {
    const parsed = new URL(url);
    const sent: unknown = init.body ? JSON.parse(init.body) : null;
    calls.push({
      call: `${init.method} ${parsed.origin}${parsed.pathname}${parsed.searchParams.has("audience") ? `?audience=${parsed.searchParams.get("audience")}` : ""}`,
      redirect: init.redirect,
      body: isRecord(sent) ? sent : null,
    });
    if (url.startsWith(REQUEST_URL))
      return Promise.resolve(
        new Response(JSON.stringify({ value: JWT }), { status: options.github ?? 200 }),
      );
    if (options.echoAfterSignIn && parsed.pathname.startsWith(options.echoAfterSignIn))
      return Promise.resolve(
        new Response(JSON.stringify({ message: `Forbidden for ${OIDC_ACCESS_TOKEN}` }), {
          status: 403,
        }),
      );
    if (options.echo && parsed.pathname === "/api/v1/auth/oidc-auth/login")
      return Promise.resolve(
        new Response(JSON.stringify({ message: `Access denied for token ${JWT}` }), {
          status: 401,
        }),
      );
    if (options.dropRevoke && parsed.pathname === "/api/v1/auth/token/revoke")
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`connection dropped after ${OIDC_ACCESS_TOKEN}`));
            },
          }),
          { status: options.dropRevoke },
        ),
      );
    if (options.revoke && parsed.pathname === "/api/v1/auth/token/revoke")
      return Promise.resolve(new Response("{}", { status: options.revoke }));
    return infisical(url, init);
  };
  const warnings: string[] = [];
  const vault = infisicalBackend(credentialsFrom(env), fetch, {
    idToken: jobToken(env, fetch),
    warn: (text) => void warnings.push(text),
  });
  return { vault, calls, warnings, fake };
}

const failure = (pending: Promise<unknown>) =>
  pending.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error,
  );

function showsNoToken(...texts: unknown[]) {
  for (const text of texts) for (const token of SECRETS) expect(String(text)).not.toContain(token);
}

const GITHUB = "GET https://pipelines.actions.githubusercontent.com/abc/idtoken";
const LOGIN = "POST https://app.infisical.com/api/v1/auth/oidc-auth/login";
const DETAILS = "GET https://app.infisical.com/api/v1/identities/details";
const REVOKE = "POST https://app.infisical.com/api/v1/auth/token/revoke";

describe("signing in with GitHub Actions OIDC", () => {
  test("exchanges GitHub's token, checks the organization, reads, then revokes on close", async () => {
    const run = setup();
    expect((await run.vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    await run.vault.close?.();
    expect(run.calls.map((c) => c.call)).toEqual([
      GITHUB,
      LOGIN,
      DETAILS,
      "GET https://app.infisical.com/api/v1/projects/slug/billing",
      "GET https://app.infisical.com/api/v4/secrets/STRIPE_KEY",
      REVOKE,
    ]);
    expect(run.calls[1]?.body).toEqual({ identityId: IDENTITY, jwt: JWT });
    expect(run.calls.at(-1)?.body).toEqual({ accessToken: OIDC_ACCESS_TOKEN });
    expect(run.calls.every((c) => c.redirect === "error")).toBe(true);
    expect(run.fake.revoked).toEqual([OIDC_ACCESS_TOKEN]);
    expect(run.warnings).toEqual([]);
  });

  test("asks GitHub for the audience in KEYPIN_INFISICAL_AUDIENCE", async () => {
    const run = setup({ env: { KEYPIN_INFISICAL_AUDIENCE: "https://app.infisical.com" } });
    await run.vault.read(REF);
    expect(run.calls[0]?.call).toBe(`${GITHUB}?audience=https://app.infisical.com`);
  });

  test("Universal Auth sessions aren't revoked on close", async () => {
    const fake: FakeInfisical = {
      organization: "acme",
      projects: { billing: { prod: { STRIPE_KEY: { value: SENTINEL } } } },
    };
    const paths: string[] = [];
    const served = infisicalFetch(fake, memoryStore());
    const vault = infisicalBackend({ clientId: "id", clientSecret: "secret" }, (url, init) => {
      paths.push(new URL(url).pathname);
      return served(url, init);
    });
    await vault.read(REF);
    await vault.close?.();
    expect(paths).not.toContain("/api/v1/auth/token/revoke");
  });

  test.each([
    ["INFISICAL_TOKEN", "INFISICAL_TOKEN"],
    ["INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN", "INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN"],
    ["INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"],
  ])("the identity with %s set too is an error naming both", async (name, named) => {
    const run = setup({ env: { [name]: "stored-credential" } });
    const error = await failure(run.vault.read(REF));
    expect(error).toBeInstanceOf(SignInFailed);
    expect(String(error)).toContain(
      `sign-in failed: both KEYPIN_INFISICAL_IDENTITY_ID and ${named} are set; unset ${named} to sign in with GitHub Actions OIDC, or KEYPIN_INFISICAL_IDENTITY_ID to sign in with it`,
    );
    expect(run.calls).toEqual([]);
  });

  test("the identity outside a job that can ask for a token says to grant id-token: write", async () => {
    const run = setup({
      env: { ACTIONS_ID_TOKEN_REQUEST_URL: "", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" },
    });
    const error = await failure(run.vault.read(REF));
    expect(error).toBeInstanceOf(SignInFailed);
    expect(error instanceof SignInFailed && error.reason).toEqual({ kind: "no-credentials" });
    expect(String(error)).toContain(
      `sign-in failed: KEYPIN_INFISICAL_IDENTITY_ID is set, but ${NO_JOB}, or unset KEYPIN_INFISICAL_IDENTITY_ID to sign in another way`,
    );
    expect(run.calls).toEqual([]);
  });

  test("GitHub's token endpoint failing is its own error, and Infisical is never asked", async () => {
    const run = setup({ github: 500 });
    const error = await failure(run.vault.read(REF));
    expect(String(error)).toContain(
      "sign-in failed: couldn't get GitHub Actions' OIDC token: GitHub's OIDC token endpoint returned HTTP 500",
    );
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB]);
  });

  test("Infisical refusing the exchange names the audience keypin asked for, and falls back to nothing", async () => {
    const plain = setup({ oidc: { jwt: "another-jwt" } });
    const given = setup({
      oidc: { jwt: "another-jwt" },
      env: { KEYPIN_INFISICAL_AUDIENCE: "https://app.infisical.com" },
    });
    const errors = [await failure(plain.vault.read(REF)), await failure(given.vault.read(REF))];
    expect(String(errors[0])).toContain(
      `sign-in failed: Infisical refused GitHub's OIDC token for the machine identity ${IDENTITY} (Infisical returned HTTP 401: Access denied: OIDC audience not allowed.); keypin asked GitHub for a token for GitHub's default audience, https://github.com/<owner>, so check that the identity's OIDC Auth lists it under Audiences and that its subject matches this job`,
    );
    expect(String(errors[1])).toContain(
      "keypin asked GitHub for a token for https://app.infisical.com, so check",
    );
    await failure(plain.vault.read(REF));
    expect(plain.calls.map((c) => c.call)).toEqual([GITHUB, LOGIN]);
  });

  test("a url outside Infisical Cloud is refused before GitHub's token is asked for", async () => {
    const self = { ...REF, url: "https://infisical.acme.dev" };
    const refused = setup();
    expect(String(await failure(refused.vault.read(self)))).toContain(
      "sign-in failed: keypin sends GitHub's OIDC token only to Infisical Cloud, and secretspec.toml's url is https://infisical.acme.dev; if that server is yours, set KEYPIN_INFISICAL_URL=https://infisical.acme.dev in the job",
    );
    expect(refused.calls).toEqual([]);
    const otherServer = setup({ env: { KEYPIN_INFISICAL_URL: "https://elsewhere.acme.dev" } });
    await failure(otherServer.vault.read(self));
    expect(otherServer.calls).toEqual([]);
    const confirmed = setup({ env: { KEYPIN_INFISICAL_URL: "https://infisical.acme.dev/" } });
    expect((await confirmed.vault.read(self)).equals(new Secret(SENTINEL))).toBe(true);
    const eu = setup();
    expect(
      (await eu.vault.read({ ...REF, url: "https://eu.infisical.com" })).equals(
        new Secret(SENTINEL),
      ),
    ).toBe(true);
  });

  test("an identity from another organization is revoked, and nothing is read", async () => {
    const run = setup({ organization: "other" });
    const error = await failure(run.vault.read(REF));
    expect(String(error)).toContain("the machine identity belongs to the organization other");
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB, LOGIN, DETAILS, REVOKE]);
    expect(run.fake.revoked).toEqual([OIDC_ACCESS_TOKEN]);
    await run.vault.close?.();
    expect(run.fake.revoked).toEqual([OIDC_ACCESS_TOKEN]);
  });

  test("a token that lives longer than an hour warns once to shorten the identity's TTLs", async () => {
    for (const oidc of [{ expiresIn: 7200 }, { accessTokenMaxTTL: 2592000 }]) {
      const run = setup({ oidc });
      await run.vault.read(REF);
      await run.vault.read(REF);
      expect(run.warnings).toEqual([
        `the Infisical machine identity ${IDENTITY} gives out access tokens that last more than an hour; set its Access Token TTL and Access Token Max TTL to a few minutes`,
      ]);
    }
  });

  test("a revoke Infisical refuses warns without the token", async () => {
    const run = setup({ revoke: 500 });
    await run.vault.read(REF);
    await run.vault.close?.();
    expect(run.warnings).toEqual([
      "Infisical organization acme at https://app.infisical.com: couldn't revoke keypin's access token (Infisical returned HTTP 500); it lasts until its TTL runs out",
    ]);
  });

  test("a server message that echoes GitHub's token shows it hidden", async () => {
    const run = setup({ echo: true });
    const error = await failure(run.vault.read(REF));
    expect(String(error)).toContain(
      "Infisical returned HTTP 401: Access denied for token [hidden]",
    );
    showsNoToken(error);
  });

  test("a server message after sign-in that echoes Infisical's access token shows it hidden", async () => {
    for (const path of [
      "/api/v1/identities/details",
      "/api/v1/projects/slug/",
      "/api/v4/secrets/",
    ]) {
      const run = setup({ echoAfterSignIn: path });
      const error = await failure(run.vault.read(REF));
      expect(String(error)).toContain("Forbidden for [hidden]");
      showsNoToken(error);
    }
  });

  test("a failed revoke whose response breaks off warns instead of failing, without the token", async () => {
    const run = setup({ dropRevoke: 500 });
    await run.vault.read(REF);
    await run.vault.close?.();
    expect(run.warnings).toEqual([
      "Infisical organization acme at https://app.infisical.com: couldn't revoke keypin's access token (connection dropped after [hidden]); it lasts until its TTL runs out",
    ]);
  });

  test("a revoke Infisical answers with 200 counts as done, even if the body breaks off", async () => {
    const run = setup({ dropRevoke: 200 });
    await run.vault.read(REF);
    await run.vault.close?.();
    expect(run.warnings).toEqual([]);
  });

  test("no error or warning shows GitHub's token, its request token or Infisical's access token", async () => {
    const texts: unknown[] = [];
    for (const options of [
      { oidc: { jwt: "another-jwt" } },
      { github: 500 },
      { organization: "other" },
      { oidc: { expiresIn: 7200 } },
      { revoke: 500 },
    ]) {
      const run = setup(options);
      texts.push(
        await run.vault.read(REF).then(
          () => "",
          (error: unknown) => error,
        ),
      );
      await run.vault.close?.();
      texts.push(...run.warnings);
    }
    expect(texts.filter(Boolean)).toHaveLength(5);
    showsNoToken(...texts);
  });
});
