import { describe, expect, test } from "vite-plus/test";
import { type Fetch, Secret, SignInFailed } from "@keypin/core";
import { awsSignIn, secretsManagerBackend, type SecretsManagerRef } from "../../src/aws/index";
import {
  type FakeSecretsManager,
  memorySecrets,
  secretsManagerFetch,
  WEB_IDENTITY_EXPIRATION,
} from "../../src/aws/testing";
import { githubIdToken } from "../../src/github/index";

const ACCOUNT = "123456789012";
const ROLE = "arn:aws:iam::123456789012:role/keypin-read";
const JWT = "github-jwt-sentinel-5c1e";
const REQUEST_TOKEN = "github-request-token-sentinel-7d0b";
const REQUEST_URL = "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0";
const MINTED = {
  id: "ASIAMINTEDMINTED0001",
  secret: "minted-secret-sentinel-9e4a",
  token: "minted-session-sentinel-1f6c",
};
const STATIC = { id: "AKIASTATICSTATIC0001", secret: "static-secret-sentinel-2a8d" };
const SENTINEL = "sentinel-value-4b7e";
const SECRETS = [JWT, REQUEST_TOKEN, MINTED.secret, MINTED.token, STATIC.secret];
const NOW = new Date("2026-11-20T12:00:00Z");

const REF: SecretsManagerRef = {
  kind: "awssm",
  account: ACCOUNT,
  region: "eu-west-1",
  name: "prod/stripe",
  field: null,
};

const JOB = {
  KEYPIN_AWS_ROLE_ARN: ROLE,
  ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
};

interface Call {
  call: string;
  form: URLSearchParams;
  headers: Record<string, string>;
  redirect: string | undefined;
}

function setup(
  options: {
    env?: Record<string, string>;
    jwt?: string;
    role?: string;
    account?: string;
    github?: number[];
    sts?: number[];
    echo?: boolean;
  } = {},
) {
  const env = { ...JOB, ...options.env };
  const fake: FakeSecretsManager = {
    account: ACCOUNT,
    credentials: [STATIC],
    webIdentity: {
      role: options.role ?? ROLE,
      jwt: options.jwt ?? `${JWT}:sts.amazonaws.com`,
      minted: { ...MINTED, ...(options.account ? { account: options.account } : {}) },
    },
    secrets: { "eu-west-1/prod/stripe": { value: SENTINEL } },
  };
  const aws = secretsManagerFetch(fake, memorySecrets());
  const calls: Call[] = [];
  const clock = { now: NOW };
  const fetch: Fetch = (url, init) => {
    const parsed = new URL(url);
    const form = new URLSearchParams(init.body ?? "");
    const action = form.get("Action") ?? init.headers["X-Amz-Target"] ?? "";
    calls.push({
      call: url.startsWith(REQUEST_URL)
        ? `GitHub ${parsed.searchParams.get("audience")}`
        : `${parsed.hostname} ${action}`,
      form,
      headers: init.headers,
      redirect: init.redirect,
    });
    if (url.startsWith(REQUEST_URL))
      return Promise.resolve(
        new Response(JSON.stringify({ value: `${JWT}:${parsed.searchParams.get("audience")}` }), {
          status: options.github?.shift() ?? 200,
        }),
      );
    const outage = action === "AssumeRoleWithWebIdentity" ? options.sts?.shift() : undefined;
    if (outage !== undefined && outage !== 200)
      return Promise.resolve(
        new Response(
          "<ErrorResponse><Error><Code>ServiceUnavailable</Code><Message>try again</Message></Error></ErrorResponse>",
          { status: outage },
        ),
      );
    if (options.echo && action === "AssumeRoleWithWebIdentity")
      return Promise.resolve(
        new Response(
          `<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Not authorized for ${form.get("WebIdentityToken")}</Message></Error></ErrorResponse>`,
          { status: 403 },
        ),
      );
    return aws(url, init);
  };
  const vault = secretsManagerBackend(
    awsSignIn(env, "/home/me", () => null),
    {
      fetch,
      now: () => clock.now,
      idToken: githubIdToken(env, fetch),
    },
  );
  return { vault, calls, clock };
}

async function failure(pending: Promise<unknown>): Promise<SignInFailed> {
  const outcome = await pending.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof SignInFailed)) throw new Error("expected a sign-in failure");
  return outcome;
}

function showsNoSecret(...texts: unknown[]) {
  for (const text of texts)
    for (const secret of SECRETS) expect(String(text)).not.toContain(secret);
}

const GITHUB = "GitHub sts.amazonaws.com";
const ASSUME = "sts.eu-west-1.amazonaws.com AssumeRoleWithWebIdentity";
const IDENTITY = "sts.eu-west-1.amazonaws.com GetCallerIdentity";
const READ = "secretsmanager.eu-west-1.amazonaws.com secretsmanager.GetSecretValue";

describe("signing in to AWS with GitHub Actions OIDC", () => {
  test("exchanges GitHub's token for the role, checks the account with it, then reads", async () => {
    const run = setup();
    expect((await run.vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB, ASSUME, IDENTITY, READ]);
    const assume = run.calls[1];
    const form = Object.fromEntries(assume?.form ?? []);
    expect(form.RoleSessionName).toMatch(/^keypin-[\w+=,.@-]{1,57}$/);
    expect({ ...form, RoleSessionName: "" }).toEqual({
      Action: "AssumeRoleWithWebIdentity",
      Version: "2011-06-15",
      RoleArn: ROLE,
      RoleSessionName: "",
      WebIdentityToken: `${JWT}:sts.amazonaws.com`,
      DurationSeconds: "900",
    });
    expect(assume?.headers.Authorization).toBeUndefined();
    expect(assume?.redirect).toBe("error");
    for (const signed of run.calls.slice(2)) {
      expect(signed.headers.Authorization).toContain(`Credential=${MINTED.id}/`);
      expect(signed.headers["X-Amz-Security-Token"]).toBe(MINTED.token);
    }
  });

  test("mints new credentials a minute before the old ones expire, and checks the account again", async () => {
    const run = setup();
    const expires = Date.parse(WEB_IDENTITY_EXPIRATION);
    await run.vault.read(REF);
    run.clock.now = new Date(expires - 61_000);
    await run.vault.read(REF);
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB, ASSUME, IDENTITY, READ, READ]);
    run.clock.now = new Date(expires - 59_000);
    expect((await run.vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    expect(run.calls.slice(5).map((c) => c.call)).toEqual([GITHUB, ASSUME, IDENTITY, READ]);
  });

  test.each([
    ["GitHub", { github: [500] }, [GITHUB]],
    ["STS", { sts: [503] }, [GITHUB, ASSUME]],
  ])("a failed sign-in at %s is tried again by the next read", async (_, outage, failed) => {
    const run = setup(outage);
    await failure(run.vault.read(REF));
    expect(run.calls.map((c) => c.call)).toEqual(failed);
    expect((await run.vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    expect(run.calls.slice(failed.length).map((c) => c.call)).toEqual([
      GITHUB,
      ASSUME,
      IDENTITY,
      READ,
    ]);
  });

  test("a failed refresh is tried again by the next read", async () => {
    const run = setup({ sts: [200, 503] });
    await run.vault.read(REF);
    run.clock.now = new Date(Date.parse(WEB_IDENTITY_EXPIRATION) - 30_000);
    await failure(run.vault.read(REF));
    expect((await run.vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    expect(run.calls.slice(4).map((c) => c.call)).toEqual([
      GITHUB,
      ASSUME,
      GITHUB,
      ASSUME,
      IDENTITY,
      READ,
    ]);
  });

  test("asks GitHub for the audience in KEYPIN_AWS_AUDIENCE", async () => {
    const run = setup({
      env: { KEYPIN_AWS_AUDIENCE: "https://github.com/acme" },
      jwt: `${JWT}:https://github.com/acme`,
    });
    expect((await run.vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    expect(run.calls.map((c) => c.call)).toEqual([
      "GitHub https://github.com/acme",
      ASSUME,
      IDENTITY,
      READ,
    ]);
  });

  test.each([
    [
      { AWS_ACCESS_KEY_ID: STATIC.id, AWS_SECRET_ACCESS_KEY: STATIC.secret },
      "both KEYPIN_AWS_ROLE_ARN and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set; unset AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to sign in with GitHub Actions OIDC, or KEYPIN_AWS_ROLE_ARN to sign in with them",
    ],
    [
      { AWS_PROFILE: "work" },
      "both KEYPIN_AWS_ROLE_ARN and AWS_PROFILE are set; unset AWS_PROFILE to sign in with GitHub Actions OIDC, or KEYPIN_AWS_ROLE_ARN to sign in with it",
    ],
  ])(
    "refuses the role together with stored credentials %o, and reads nothing",
    async (env, said) => {
      const run = setup({ env });
      const error = await failure(run.vault.read(REF));
      expect(error.message).toBe(`AWS account ${ACCOUNT} in eu-west-1: sign-in failed: ${said}`);
      expect(run.calls).toEqual([]);
      showsNoSecret(error.message);
    },
  );

  test("a job that can't ask GitHub for a token says to grant id-token: write, and reads nothing", async () => {
    const run = setup({
      env: { ACTIONS_ID_TOKEN_REQUEST_URL: "", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" },
    });
    const error = await failure(run.vault.read(REF));
    expect(error.reason).toEqual({ kind: "no-credentials" });
    expect(error.message).toBe(
      `AWS account ${ACCOUNT} in eu-west-1: sign-in failed: KEYPIN_AWS_ROLE_ARN is set, but this job can't ask GitHub Actions for an OIDC token (ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN aren't set); give it permissions: id-token: write, or unset KEYPIN_AWS_ROLE_ARN to sign in another way`,
    );
    expect(run.calls).toEqual([]);
  });

  test("GitHub's token endpoint failing stops sign-in before STS", async () => {
    const run = setup({ github: [500] });
    const error = await failure(run.vault.read(REF));
    expect(error.message).toBe(
      `AWS account ${ACCOUNT} in eu-west-1: sign-in failed: couldn't get GitHub Actions' OIDC token: GitHub's OIDC token endpoint returned HTTP 500`,
    );
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB]);
  });

  test("STS refusing the token names the audience, falls back to nothing, and hides the token", async () => {
    const run = setup({ role: "arn:aws:iam::123456789012:role/other", echo: true });
    const error = await failure(run.vault.read(REF));
    expect(error.message).toBe(
      `AWS account ${ACCOUNT} in eu-west-1: sign-in failed: AWS STS refused GitHub's OIDC token for the role ${ROLE} (AWS AssumeRoleWithWebIdentity returned HTTP 403 AccessDenied: Not authorized for [hidden]); keypin asked GitHub for a token for the audience sts.amazonaws.com, so check that the role's trust policy allows that audience and this job's subject`,
    );
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB, ASSUME]);
    showsNoSecret(error.message);
  });

  test("STS's own refusal of a token for another audience comes through", async () => {
    const run = setup({ jwt: `${JWT}:https://github.com/acme` });
    const error = await failure(run.vault.read(REF));
    expect(error.message).toContain(
      "(AWS AssumeRoleWithWebIdentity returned HTTP 400 InvalidIdentityToken: Incorrect token audience)",
    );
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB, ASSUME]);
  });

  test("a role in another account is refused before any read", async () => {
    const run = setup({ account: "999999999999" });
    const error = await failure(run.vault.read(REF));
    expect(error.reason).toEqual({
      kind: "wrong-account",
      pinned: ACCOUNT,
      actual: "999999999999",
    });
    expect(error.message).toBe(
      `AWS account ${ACCOUNT} in eu-west-1: sign-in failed: the role in KEYPIN_AWS_ROLE_ARN belongs to AWS account 999999999999, but keypin.toml pins ${ACCOUNT}`,
    );
    expect(run.calls.map((c) => c.call)).toEqual([GITHUB, ASSUME, IDENTITY]);
  });

  test("without KEYPIN_AWS_ROLE_ARN, keypin signs in with the stored keys as before", async () => {
    const run = setup({
      env: {
        KEYPIN_AWS_ROLE_ARN: "",
        AWS_ACCESS_KEY_ID: STATIC.id,
        AWS_SECRET_ACCESS_KEY: STATIC.secret,
      },
    });
    expect((await run.vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    run.clock.now = new Date(Date.parse(WEB_IDENTITY_EXPIRATION) + 3_600_000);
    await run.vault.read(REF);
    expect(run.calls.map((c) => c.call)).toEqual([IDENTITY, READ, READ]);
    expect(run.calls[0]?.headers.Authorization).toContain(`Credential=${STATIC.id}/`);
  });
});
