import { describe, expect, test } from "vite-plus/test";
import { type Fetch, Secret, SignInFailed, WriteRefused } from "@keypin/core";
import { day, expectNoneOf } from "@keypin/core/testing";
import {
  type AwsSignIn,
  awsSignIn,
  secretsManagerBackend,
  type SecretsManagerRef,
  secretsManagerVault,
} from "../../src/aws/index";
import {
  type FakeAwsSecret,
  type FakeSecretsManager,
  memorySecrets,
  secretsManagerFetch,
} from "../../src/aws/testing";

const ACCOUNT = "123456789012";
const KEY = { id: "AKIAAPPAPPAPPAPP0001", secret: "sm/secret/0001" };
const TEMPORARY = { id: "ASIAAPPAPPAPPAPP0002", secret: "sm/secret/0002", token: "session-2" };
const NOW = new Date("2026-11-18T12:00:00Z");
const SENTINEL = "sentinel-value-3c9b1e";
const ROTATED = day("2026-11-18");

async function caught(promise: Promise<unknown> | undefined): Promise<Error> {
  const outcome = await Promise.resolve(promise).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("expected a rejection with an Error");
  return outcome;
}

const expectNoSentinel = (...seen: unknown[]) => expectNoneOf([SENTINEL], ...seen);

const ref = (
  name: string,
  field: string | null = null,
  region = "eu-west-1",
): SecretsManagerRef => ({
  kind: "awssm",
  account: ACCOUNT,
  region,
  name,
  field,
});

function setup(
  secrets: Record<string, FakeAwsSecret>,
  options: Partial<FakeSecretsManager> = {},
  signIn: AwsSignIn = { credentials: KEY, source: "the access key in AWS_ACCESS_KEY_ID" },
) {
  const fake: FakeSecretsManager = {
    account: ACCOUNT,
    credentials: [KEY, TEMPORARY],
    secrets,
    ...options,
  };
  const store = memorySecrets();
  const calls: string[] = [];
  const inner = secretsManagerFetch(fake, store);
  const fetch: Fetch = (url, init) => {
    calls.push(`${new URL(url).host} ${init.headers["X-Amz-Target"] ?? "sts"}`);
    return inner(url, init);
  };
  let tokens = 0;
  const vault = secretsManagerBackend(signIn, {
    fetch,
    now: () => NOW,
    requestToken: () => `00000000-0000-4000-8000-${String(++tokens).padStart(12, "0")}`,
  });
  return { vault, fake, store, calls };
}

describe("reading", () => {
  test("signs in once per region with STS, then reads from the regional endpoint", async () => {
    const run = setup({ "eu-west-1/prod/stripe": { value: SENTINEL } });
    expect((await run.vault.read(ref("prod/stripe"))).equals(new Secret(SENTINEL))).toBe(true);
    await run.vault.read(ref("prod/stripe"));
    expect(run.calls).toEqual([
      "sts.eu-west-1.amazonaws.com sts",
      "secretsmanager.eu-west-1.amazonaws.com secretsmanager.GetSecretValue",
      "secretsmanager.eu-west-1.amazonaws.com secretsmanager.GetSecretValue",
    ]);
  });

  test("signs temporary credentials with their session token", async () => {
    const run = setup(
      { "eu-west-1/prod/stripe": { value: SENTINEL } },
      {},
      { credentials: TEMPORARY, source: "the temporary credentials in AWS_ACCESS_KEY_ID" },
    );
    expect((await run.vault.read(ref("prod/stripe"))).equals(new Secret(SENTINEL))).toBe(true);
  });

  test("reads one key of a JSON secret", async () => {
    const run = setup({
      "eu-west-1/prod/app": { value: JSON.stringify({ STRIPE: SENTINEL, port: 5432 }) },
    });
    const read = await run.vault.read(ref("prod/app", "STRIPE"));
    expect(read.equals(new Secret(SENTINEL))).toBe(true);
    const missing = await caught(run.vault.read(ref("prod/app", "NOPE")));
    expect(String(missing)).toContain("the secret's JSON has no key NOPE");
    const number = await caught(run.vault.read(ref("prod/app", "port")));
    expect(String(number)).toContain("the JSON key port holds a number, not text");
    expectNoSentinel(missing, number);
  });

  test("refuses a key of a secret that isn't JSON, a binary secret, and an empty value", async () => {
    const run = setup({
      "eu-west-1/plain": { value: SENTINEL },
      "eu-west-1/binary": { value: null },
      "eu-west-1/empty": { value: "" },
    });
    const notJson = await caught(run.vault.read(ref("plain", "KEY")));
    expect(String(notJson)).toContain("the secret isn't a JSON object, so it has no key KEY");
    expect(String(await caught(run.vault.read(ref("binary"))))).toContain(
      "the secret holds binary data",
    );
    expect(String(await caught(run.vault.read(ref("empty"))))).toContain("the value is empty");
    expectNoSentinel(notJson);
  });

  test("names a missing secret, a denied read and the KMS key", async () => {
    const run = setup({ "eu-west-1/prod/stripe": { value: SENTINEL } });
    expect(String(await caught(run.vault.read(ref("prod/nope"))))).toContain(
      "no secret prod/nope in eu-west-1 (AWS GetSecretValue returned HTTP 400 ResourceNotFoundException); check the region and the name",
    );
    expect(String(await caught(run.vault.read(ref("prod/stripe", null, "us-west-2"))))).toContain(
      "no secret prod/stripe in us-west-2",
    );
    run.fake.denied = ["GetSecretValue"];
    expect(String(await caught(run.vault.read(ref("prod/stripe"))))).toContain(
      "the signed-in identity isn't allowed secretsmanager:GetSecretValue on the secret, or its KMS key",
    );
  });

  test("item IDs are the region and the secret's ARN", async () => {
    const run = setup({ "eu-west-1/prod/stripe": { value: SENTINEL } });
    const item = await run.vault.readItem(ref("prod/stripe"));
    expect(item.ids).toEqual({
      vault: "eu-west-1",
      item: `arn:aws:secretsmanager:eu-west-1:${ACCOUNT}:secret:prod/stripe-AbCdEf`,
    });
    expect(await run.vault.itemIds(ref("prod/stripe"))).toEqual(item.ids);
  });
});

describe("signing in", () => {
  test("refuses another account than the pinned one", async () => {
    const run = setup({}, { credentials: [{ ...KEY, account: "999999999999" }] });
    const failed = await caught(run.vault.read(ref("prod/stripe")));
    expect(failed).toBeInstanceOf(SignInFailed);
    expect(failed).toMatchObject({
      reason: { kind: "wrong-account", pinned: ACCOUNT, actual: "999999999999" },
    });
    expect(String(failed)).toContain(
      "the access key in AWS_ACCESS_KEY_ID belongs to AWS account 999999999999, but secretspec.toml names 123456789012",
    );
  });

  test("says what's wrong with a key AWS refuses", async () => {
    const unknown = setup({}, { credentials: [] });
    expect(String(await caught(unknown.vault.read(ref("x"))))).toContain(
      "AWS doesn't accept the access key in AWS_ACCESS_KEY_ID",
    );
    const wrong = setup({}, { credentials: [{ ...KEY, secret: "other" }] });
    expect(String(await caught(wrong.vault.read(ref("x"))))).toContain(
      "doesn't match its key ID, or this computer's clock is off",
    );
    const expired = setup(
      {},
      { credentials: [{ ...TEMPORARY, expired: true }] },
      { credentials: TEMPORARY, source: "the AWS profile dev" },
    );
    const failed = await caught(expired.vault.read(ref("x")));
    expect(failed).toBeInstanceOf(SignInFailed);
    expect(String(failed)).toContain(
      "the temporary credentials in the AWS profile dev expired (AWS GetCallerIdentity returned HTTP 403 ExpiredToken); get new ones",
    );
  });

  test("a sign-in that can't start fails without calling AWS", async () => {
    const run = setup(
      {},
      {},
      { problem: "set AWS_ACCESS_KEY_ID", reason: { kind: "no-credentials" } },
    );
    const failed = await caught(run.vault.read(ref("x")));
    expect(failed).toBeInstanceOf(SignInFailed);
    expect(failed).toMatchObject({ reason: { kind: "no-credentials" } });
    expect(run.calls).toEqual([]);
  });
});

describe("writing", () => {
  test("puts a new version with a request token, and keeps a JSON secret's other keys", async () => {
    const run = setup({
      "eu-west-1/prod/app": { value: JSON.stringify({ STRIPE: "old", port: 5432 }) },
    });
    await run.vault.write(ref("prod/app", "STRIPE"), new Secret(SENTINEL));
    expect(run.store.load()["eu-west-1/prod/app"]?.value).toBe(
      JSON.stringify({ STRIPE: SENTINEL, port: 5432 }),
    );
    expect(run.store.effects).toEqual(["awssm put eu-west-1/prod/app"]);
  });

  test("a second key of the same JSON secret keeps the first, though AWSCURRENT reads are stale", async () => {
    const run = setup(
      { "eu-west-1/prod/app": { value: JSON.stringify({ SECRET: "old", ID: "AKID-0" }) } },
      { staleReads: "current" },
    );
    await run.vault.write(ref("prod/app", "SECRET"), new Secret(SENTINEL));
    await run.vault.write(ref("prod/app", "ID"), new Secret("AKID-1"));
    expect(run.store.load()["eu-west-1/prod/app"]?.value).toBe(
      JSON.stringify({ SECRET: SENTINEL, ID: "AKID-1" }),
    );
    expect(await run.vault.read(ref("prod/app", "SECRET"))).toEqual(new Secret(SENTINEL));
  });

  test("stops before the second write when AWS doesn't return the version keypin saved yet", async () => {
    const run = setup(
      { "eu-west-1/prod/app": { value: JSON.stringify({ SECRET: "old", ID: "AKID-0" }) } },
      { staleReads: "current-and-new-versions" },
    );
    await run.vault.write(ref("prod/app", "SECRET"), new Secret(SENTINEL));
    const refused = await caught(run.vault.write(ref("prod/app", "ID"), new Secret("AKID-1")));
    expect(refused).toBeInstanceOf(WriteRefused);
    expect(String(refused)).toContain(
      "keypin saved this secret a moment ago, but Secrets Manager doesn't return that version yet",
    );
    expect(run.store.effects).toEqual(["awssm put eu-west-1/prod/app"]);
    expectNoSentinel(refused);
  });

  test("the rotated date is the current version's day for a whole secret", async () => {
    const run = setup({
      "eu-west-1/prod/stripe": { value: "old", created: "2026-08-01T10:00:00Z" },
    });
    expect(await run.vault.metadata(ref("prod/stripe"))).toEqual({ rotated: "2026-08-01" });
    await run.vault.write(ref("prod/stripe"), new Secret(SENTINEL), {
      rotated: ROTATED,
    });
    expect(await run.vault.metadata(ref("prod/stripe"))).toEqual({ rotated: "2026-11-18" });
  });

  test("a JSON key's rotated date is its tag, and a bad tag is named", async () => {
    const run = setup({
      "eu-west-1/prod/app": {
        value: JSON.stringify({ STRIPE: "old", OTHER: "x" }),
        tags: { "keypin-rotated:OTHER": "someday" },
      },
    });
    expect(await run.vault.metadata(ref("prod/app", "STRIPE"))).toEqual({ rotated: null });
    await run.vault.write(ref("prod/app", "STRIPE"), new Secret(SENTINEL), {
      rotated: ROTATED,
    });
    expect(await run.vault.metadata(ref("prod/app", "STRIPE"))).toEqual({ rotated: "2026-11-18" });
    expect(String(await caught(run.vault.metadata(ref("prod/app", "OTHER"))))).toContain(
      `the tag keypin-rotated:OTHER isn't a YYYY-MM-DD date: "someday"`,
    );
  });

  test("says the value was saved when only the tag fails", async () => {
    const run = setup(
      { "eu-west-1/prod/app": { value: JSON.stringify({ STRIPE: "old" }) } },
      { denied: ["TagResource"] },
    );
    const failed = await caught(
      run.vault.write(ref("prod/app", "STRIPE"), new Secret(SENTINEL), {
        rotated: ROTATED,
      }),
    );
    expect(failed).not.toBeInstanceOf(WriteRefused);
    expect(String(failed)).toContain(
      "keypin saved the new value, but couldn't set the tag keypin-rotated:STRIPE to 2026-11-18",
    );
    expect(run.store.effects).toEqual(["awssm put eu-west-1/prod/app"]);
    expectNoSentinel(failed);
  });

  test.each([
    [{ rotation: true }, "Secrets Manager rotates this secret itself"],
    [{ owner: "rds" }, "rds manages this secret, so keypin leaves its value to it"],
    [{ deleted: true }, "the secret is scheduled for deletion"],
  ])("refuses to write a secret AWS manages: %o", async (extra, message) => {
    const run = setup({ "eu-west-1/prod/stripe": { value: "old", ...extra } });
    const check = await caught(run.vault.checkWrite?.(ref("prod/stripe")));
    expect(String(check)).toContain(message);
    const refused = await caught(run.vault.write(ref("prod/stripe"), new Secret(SENTINEL)));
    expect(refused).toBeInstanceOf(WriteRefused);
    expect(String(refused)).toContain(message);
    expect(run.store.effects).toEqual([]);
  });

  test("refuses to write a key a JSON secret doesn't have", async () => {
    const run = setup({ "eu-west-1/prod/app": { value: JSON.stringify({ OTHER: "x" }) } });
    const refused = await caught(run.vault.write(ref("prod/app", "STRIPE"), new Secret(SENTINEL)));
    expect(refused).toBeInstanceOf(WriteRefused);
    expect(String(refused)).toContain("the secret's JSON has no key STRIPE");
    expect(run.store.effects).toEqual([]);
  });

  test("doesn't create a secret, and a failed put isn't a refusal", async () => {
    const run = setup({ "eu-west-1/prod/stripe": { value: "old" } }, { failPut: 500 });
    const created = await caught(
      run.vault.write(ref("prod/new"), new Secret(SENTINEL), { newItem: true }),
    );
    expect(created).toBeInstanceOf(WriteRefused);
    expect(String(created)).toContain("keypin doesn't create AWS secrets");
    const failed = await caught(run.vault.write(ref("prod/stripe"), new Secret(SENTINEL)));
    expect(failed).not.toBeInstanceOf(WriteRefused);
    expect(String(failed)).toContain("AWS PutSecretValue returned HTTP 500");
    expectNoSentinel(created, failed);
  });
});

describe("credentials", () => {
  const files = (contents: Record<string, string>) => (path: string) => contents[path] ?? null;

  test("environment keys come first, with a session token when set", () => {
    const signIn = awsSignIn(
      {
        AWS_ACCESS_KEY_ID: KEY.id,
        AWS_SECRET_ACCESS_KEY: KEY.secret,
        AWS_SESSION_TOKEN: "t",
        AWS_PROFILE: "dev",
      },
      "/home/me",
      files({}),
    );
    expect(signIn).toEqual({
      credentials: { ...KEY, token: "t" },
      source: "the temporary credentials in AWS_ACCESS_KEY_ID, not the profile in AWS_PROFILE",
    });
  });

  test("refuses half a key in the environment", () => {
    expect(awsSignIn({ AWS_ACCESS_KEY_ID: KEY.id }, "/home/me", files({}))).toMatchObject({
      problem:
        "AWS_ACCESS_KEY_ID is set but AWS_SECRET_ACCESS_KEY isn't; set both, or neither to use AWS_PROFILE",
    });
  });

  test("reads a profile's keys from the credentials and config files", () => {
    const read = files({
      "/home/me/.aws/credentials": `[default]\naws_access_key_id = ${KEY.id}\naws_secret_access_key = ${KEY.secret}\n\n[dev]\naws_access_key_id=${TEMPORARY.id}\naws_secret_access_key=${TEMPORARY.secret}\naws_session_token=${TEMPORARY.token}\n`,
      "/custom/config": "[profile cfg]\naws_access_key_id = AKIACFG\naws_secret_access_key = cfg\n",
    });
    expect(awsSignIn({}, "/home/me", read)).toEqual({
      credentials: KEY,
      source: "the AWS profile default",
    });
    expect(awsSignIn({ AWS_PROFILE: "dev" }, "/home/me", read)).toEqual({
      credentials: TEMPORARY,
      source: "the AWS profile dev",
    });
    expect(
      awsSignIn({ AWS_PROFILE: "cfg", AWS_CONFIG_FILE: "/custom/config" }, "/home/me", read),
    ).toEqual({ credentials: { id: "AKIACFG", secret: "cfg" }, source: "the AWS profile cfg" });
  });

  test("reads equally indented keys, and skips settings nested under one", () => {
    const keys = `    aws_access_key_id = ${TEMPORARY.id}\n    aws_secret_access_key = ${TEMPORARY.secret}\n    aws_session_token = ${TEMPORARY.token}\n`;
    const nested = "    s3 =\n        aws_session_token = nested\n";
    const read = files({
      "/home/me/.aws/credentials": `[default]\n${keys}`,
      "/home/me/.aws/config": `[profile cfg]\n${nested}${keys}[profile only-nested]\naws_access_key_id = AKIA\naws_secret_access_key = s\ns3 =\n  aws_session_token = nested\n`,
    });
    const expected = (profile: string) => ({
      credentials: TEMPORARY,
      source: `the AWS profile ${profile}`,
    });
    expect(awsSignIn({}, "/home/me", read)).toEqual(expected("default"));
    expect(awsSignIn({ AWS_PROFILE: "cfg" }, "/home/me", read)).toEqual(expected("cfg"));
    expect(awsSignIn({ AWS_PROFILE: "only-nested" }, "/home/me", read)).toEqual({
      credentials: { id: "AKIA", secret: "s" },
      source: "the AWS profile only-nested",
    });
  });

  test.each([
    ["sso_session = corp", "IAM Identity Center (SSO)"],
    ["credential_process = /bin/get-creds", "credential_process"],
    ["role_arn = arn:aws:iam::1:role/x\nsource_profile = default", "an assumed role"],
    ["login_session = arn:aws:iam::1:user/x", "aws login"],
  ])("refuses a profile that signs in itself: %s", (setting, how) => {
    const read = files({
      "/home/me/.aws/config": `[profile work]\nregion = eu-west-1\n${setting}\n`,
    });
    const signIn = awsSignIn({ AWS_PROFILE: "work" }, "/home/me", read);
    expect(signIn).toMatchObject({
      problem: `the AWS profile work signs in with ${how}, which keypin doesn't do itself; run eval "$(aws configure export-credentials --profile work --format env)" first, so keypin uses the temporary credentials it exports`,
    });
  });

  test("names a missing profile, and says how to sign in with none", () => {
    expect(awsSignIn({ AWS_PROFILE: "gone" }, "/home/me", files({}))).toMatchObject({
      problem:
        "AWS_PROFILE names the profile gone, which isn't in /home/me/.aws/credentials or /home/me/.aws/config",
    });
    expect(awsSignIn({}, "/home/me", files({}))).toMatchObject({
      reason: { kind: "no-credentials" },
    });
    const empty = awsSignIn(
      {},
      "/home/me",
      files({ "/home/me/.aws/config": "[default]\nregion = us-east-1\n" }),
    );
    expect("problem" in empty && empty.problem).toContain(
      "the AWS profile default has no aws_access_key_id",
    );
  });
});

describe("references", () => {
  const parse = (rest: string) => secretsManagerVault.parse(rest);
  const format = (found: SecretsManagerRef) => secretsManagerVault.format(found);

  test.each([
    ["us-east-1/prod/stripe", { region: "us-east-1", name: "prod/stripe", field: null }],
    ["eu-central-1/app:STRIPE_KEY", { region: "eu-central-1", name: "app", field: "STRIPE_KEY" }],
    [
      "us-gov-west-1/a+b=c.d@e-f_g",
      { region: "us-gov-west-1", name: "a+b=c.d@e-f_g", field: null },
    ],
  ])("parses awssm://%s", (rest, expected) => {
    const parsed = parse(rest);
    expect(parsed).toEqual({ kind: "awssm", ...expected });
    if (typeof parsed !== "string")
      expect(format({ ...parsed, account: ACCOUNT })).toBe(`awssm://${rest}`);
  });

  test.each([
    "prod/stripe",
    "us-east-1/",
    "us-east-1/app:",
    "us-east-1/my secret",
    "arn:aws:secretsmanager:us-east-1:1:secret:x",
  ])("refuses awssm://%s", (rest) => {
    const parsed = parse(rest);
    expect(typeof parsed === "string" && parsed).toContain(
      "must be awssm://<region>/<secret name>",
    );
  });
});
