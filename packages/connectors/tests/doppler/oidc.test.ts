import { describe, expect, test } from "vite-plus/test";
import { type Fetch, isRecord, Secret, SignInFailed } from "@keypin/core";
import { credentialsFrom, dopplerBackend, type DopplerRef } from "../../src/doppler/index";
import { githubIdToken } from "../../src/github/index";
import { dopplerFetch, type FakeDoppler, memoryStore, OIDC_TOKEN } from "../../src/doppler/testing";

const IDENTITY = "8c2d4e6f-0000-4000-8000-000000000002";
const JWT = "github-jwt-sentinel-4e1a";
const REQUEST_TOKEN = "github-request-token-sentinel-9c3d";
const REQUEST_URL = "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0";
const SENTINEL = "sentinel-value-2d7b";
const SECRETS = [JWT, REQUEST_TOKEN, OIDC_TOKEN];

const REF: DopplerRef = {
  kind: "doppler",
  workplace: "acme",
  project: "billing",
  config: "prd",
  name: "STRIPE_KEY",
};

const JOB = {
  KEYPIN_DOPPLER_IDENTITY_ID: IDENTITY,
  ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
};

const NO_JOB =
  "this job can't ask GitHub Actions for an OIDC token (ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN aren't set); give it permissions: id-token: write";

function setup(
  options: {
    env?: Record<string, string>;
    oidc?: Partial<NonNullable<FakeDoppler["oidc"]>>;
    workplace?: string;
    github?: number;
    revoke?: number;
    echo?: boolean;
    dropRevoke?: number;
    echoing?: string;
    echoStatus?: number;
  } = {},
) {
  const env = { ...JOB, ...options.env };
  const fake: FakeDoppler = {
    workplace: options.workplace ?? "acme",
    projects: { billing: { prd: { STRIPE_KEY: { value: SENTINEL } } } },
    tokens: {},
    oidc: { identityId: IDENTITY, jwt: JWT, ...options.oidc },
  };
  const doppler = dopplerFetch(fake, memoryStore());
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
        init.headers.Authorization === `bearer ${REQUEST_TOKEN}`
          ? new Response(JSON.stringify({ count: 1, value: JWT }), {
              status: options.github ?? 200,
            })
          : new Response("{}", { status: 401 }),
      );
    if (options.echoing === parsed.pathname)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            messages: [
              `Bad bearer ${init.headers.Authorization ?? ""} from ${JWT}`,
              ...(init.body ? [`for ${init.body}`] : []),
            ],
            success: false,
          }),
          { status: options.echoStatus ?? 500 },
        ),
      );
    if (options.echo && parsed.pathname === "/v3/auth/oidc")
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [`Invalid token ${JWT}`], success: false }), {
          status: 401,
        }),
      );
    if (options.dropRevoke && parsed.pathname === "/v3/auth/revoke")
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`connection dropped after ${OIDC_TOKEN}`));
            },
          }),
          { status: options.dropRevoke },
        ),
      );
    if (options.revoke && parsed.pathname === "/v3/auth/revoke")
      return Promise.resolve(new Response("{}", { status: options.revoke }));
    return doppler(url, init);
  };
  const warnings: string[] = [];
  const vault = dopplerBackend(credentialsFrom(env), fetch, {
    idToken: githubIdToken(env, fetch),
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
const LOGIN = "POST https://api.doppler.com/v3/auth/oidc";
const ME = "GET https://api.doppler.com/v3/me";
const READ = "GET https://api.doppler.com/v3/configs/config/secret";
const REVOKE = "POST https://api.doppler.com/v3/auth/revoke";

describe("signing in with GitHub Actions OIDC", () => {
  test("exchanges GitHub's token, checks the workplace, reads, then revokes on close", async () => {
    const run = setup();
    expect((await run.vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    await run.vault.close?.();
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB, LOGIN, ME, READ, REVOKE]);
    expect(run.calls[1]?.body).toEqual({ identity: IDENTITY, token: JWT });
    expect(run.calls.at(-1)?.body).toEqual({ token: OIDC_TOKEN });
    expect(run.calls.every((c) => c.redirect === "error")).toBe(true);
    expect(run.fake.revoked).toEqual([OIDC_TOKEN]);
    expect(run.warnings).toEqual([]);
  });

  test("asks GitHub for the audience in KEYPIN_DOPPLER_AUDIENCE", async () => {
    const run = setup({ env: { KEYPIN_DOPPLER_AUDIENCE: "doppler" } });
    await run.vault.read(REF);
    expect(run.calls[0]?.call).toBe(`${GITHUB}?audience=doppler`);
  });

  test("a stored token isn't revoked on close", async () => {
    const fake: FakeDoppler = {
      workplace: "acme",
      projects: { billing: { prd: { STRIPE_KEY: { value: SENTINEL } } } },
      tokens: { "dp.sa.stored": { type: "service_account" } },
    };
    const paths: string[] = [];
    const served = dopplerFetch(fake, memoryStore());
    const vault = dopplerBackend(
      credentialsFrom({ DOPPLER_TOKEN: "dp.sa.stored" }),
      (url, init) => {
        paths.push(new URL(url).pathname);
        return served(url, init);
      },
    );
    await vault.read(REF);
    await vault.close?.();
    expect(paths).toEqual(["/v3/me", "/v3/configs/config/secret"]);
  });

  test("the identity with DOPPLER_TOKEN set too is an error naming both", async () => {
    const run = setup({ env: { DOPPLER_TOKEN: "dp.sa.stored" } });
    const error = await failure(run.vault.read(REF));
    expect(error).toBeInstanceOf(SignInFailed);
    expect(String(error)).toContain(
      "sign-in failed: both KEYPIN_DOPPLER_IDENTITY_ID and DOPPLER_TOKEN are set; unset DOPPLER_TOKEN to sign in with GitHub Actions OIDC, or KEYPIN_DOPPLER_IDENTITY_ID to sign in with it",
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
      `sign-in failed: KEYPIN_DOPPLER_IDENTITY_ID is set, but ${NO_JOB}, or unset KEYPIN_DOPPLER_IDENTITY_ID to sign in another way`,
    );
    expect(run.calls).toEqual([]);
  });

  test("GitHub's token endpoint failing is its own error, and Doppler is never asked", async () => {
    const run = setup({ github: 500 });
    const error = await failure(run.vault.read(REF));
    expect(String(error)).toContain(
      "sign-in failed: couldn't get GitHub Actions' OIDC token: GitHub's OIDC token endpoint returned HTTP 500",
    );
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB]);
  });

  test("Doppler refusing the exchange names the audience keypin asked for, and falls back to nothing", async () => {
    const plain = setup({ oidc: { jwt: "another-jwt" } });
    const given = setup({
      oidc: { jwt: "another-jwt" },
      env: { KEYPIN_DOPPLER_AUDIENCE: "doppler" },
    });
    const errors = [await failure(plain.vault.read(REF)), await failure(given.vault.read(REF))];
    expect(String(errors[0])).toContain(
      `sign-in failed: Doppler refused GitHub's OIDC token for the identity ${IDENTITY} (Doppler returned HTTP 401: Invalid OIDC token); keypin asked GitHub for a token for GitHub's default audience, https://github.com/<owner>, so check that the identity's aud claim lists it and that its sub claim matches this job`,
    );
    expect(String(errors[1])).toContain("keypin asked GitHub for a token for doppler, so check");
    await failure(plain.vault.read(REF));
    expect(plain.calls.map((c) => c.call)).toEqual([GITHUB, LOGIN]);
  });

  test("an identity from another workplace is revoked, and nothing is read", async () => {
    const run = setup({ workplace: "other" });
    const error = await failure(run.vault.read(REF));
    expect(String(error)).toContain(
      "sign-in failed: the service account identity token for the identity in KEYPIN_DOPPLER_IDENTITY_ID belongs to the workplace other Inc (other), but keypin.toml pins acme",
    );
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB, LOGIN, ME, REVOKE]);
    expect(run.fake.revoked).toEqual([OIDC_TOKEN]);
    await run.vault.close?.();
    expect(run.fake.revoked).toEqual([OIDC_TOKEN]);
  });

  test("a token that lives longer than an hour warns once to shorten the identity's TTL", async () => {
    const run = setup({ oidc: { expiresInSeconds: 7200 } });
    await run.vault.read(REF);
    await run.vault.read(REF);
    expect(run.warnings).toEqual([
      `the Doppler identity ${IDENTITY} gives out tokens that last more than an hour; set its token TTL to a few minutes`,
    ]);
  });

  test("a revoke Doppler refuses warns without the token", async () => {
    const run = setup({ revoke: 500 });
    await run.vault.read(REF);
    await run.vault.close?.();
    expect(run.warnings).toEqual([
      "Doppler workplace acme: couldn't revoke keypin's service account identity token (Doppler returned HTTP 500); it lasts until its TTL runs out",
    ]);
  });

  test("a failed revoke whose response breaks off warns instead of failing, without the token", async () => {
    const run = setup({ dropRevoke: 500 });
    await run.vault.read(REF);
    await run.vault.close?.();
    expect(run.warnings).toEqual([
      "Doppler workplace acme: couldn't revoke keypin's service account identity token (connection dropped after [hidden]); it lasts until its TTL runs out",
    ]);
  });

  test("a revoke Doppler answers with 200 counts as done, even if the body breaks off", async () => {
    const run = setup({ dropRevoke: 200 });
    await run.vault.read(REF);
    await run.vault.close?.();
    expect(run.warnings).toEqual([]);
  });

  test("a server message that echoes GitHub's token shows it hidden", async () => {
    const run = setup({ echo: true });
    const error = await failure(run.vault.read(REF));
    expect(String(error)).toContain("Doppler returned HTTP 401: Invalid token [hidden]");
    showsNoToken(error);
  });

  test("a failed workplace check that echoes Doppler's token shows it hidden, and revokes it", async () => {
    const run = setup({ echoing: "/v3/me" });
    const error = await failure(run.vault.read(REF));
    expect(String(error)).toContain(
      "couldn't read the service account identity token's workplace (Doppler returned HTTP 500: Bad bearer Bearer [hidden] from [hidden])",
    );
    showsNoToken(error);
    expect(run.fake.revoked).toEqual([OIDC_TOKEN]);
  });

  test("a failed read that echoes Doppler's token shows it hidden", async () => {
    const run = setup({ echoing: "/v3/configs/config/secret" });
    const error = await failure(run.vault.read(REF));
    expect(String(error)).toContain(
      "doppler://billing/prd/STRIPE_KEY (Doppler workplace acme): Doppler returned HTTP 500: Bad bearer Bearer [hidden] from [hidden]",
    );
    showsNoToken(error);
  });

  test.each([400, 500])(
    "a write Doppler fails with HTTP %i, echoing the new value and the token, shows both hidden",
    async (status) => {
      const value = "new-value-sentinel-3e9f";
      const run = setup({ echoing: "/v3/configs/config/secrets", echoStatus: status });
      const error = await failure(run.vault.write(REF, new Secret(value)));
      expect(String(error)).toContain(
        `Doppler returned HTTP ${status}: Bad bearer Bearer [hidden] from [hidden]; for {"project":"billing","config":"prd","secrets":{"STRIPE_KEY":"[hidden]"}}`,
      );
      expect(String(error)).not.toContain(value);
      showsNoToken(error);
    },
  );

  test("no error or warning shows GitHub's token, its request token or Doppler's token", async () => {
    const texts: unknown[] = [];
    for (const options of [
      { oidc: { jwt: "another-jwt" } },
      { github: 500 },
      { workplace: "other" },
      { oidc: { expiresInSeconds: 7200 } },
      { revoke: 500 },
      { echo: true },
      { echoing: "/v3/me" },
      { echoing: "/v3/configs/config/secret" },
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
    expect(texts.filter(Boolean)).toHaveLength(8);
    showsNoToken(...texts);
  });
});
