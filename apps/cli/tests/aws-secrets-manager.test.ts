import { describe, expect, test } from "vite-plus/test";
import { type Issuer, Secret } from "@keypin/core";
import { awsSignIn, secretsManagerBackend } from "@keypin/connectors/aws";
import {
  type FakeSecretsManager,
  memorySecrets,
  secretsManagerFetch,
} from "@keypin/connectors/aws/testing";
import { cli } from "../src/cli";
import { onePasswordFrom } from "../src/sign-in";
import { issuers } from "../src/start";
import { routedVault } from "../src/vault";
import {
  fakeDeps,
  fakeDestinations,
  fakeLauncher,
  fakeVault,
  memoryFiles,
  parseJson,
  REGISTRY,
  registryWith,
  SENTINEL,
} from "./fakes";
import { pairedKind } from "./paired";

const KEY = { id: "AKIAAPPAPPAPPAPP0001", secret: "aws-sign-in-sentinel-6d2f" };
const ISSUED = "re_issued_sentinel_value_8d3a";

const MAP = `
[awssm]
account = "123456789012"

[keys.STRIPE_API_KEY]
rotate_every = "90d"
dev = "awssm://eu-west-1/dev/billing:STRIPE_API_KEY"

[keys.STRIPE_API_KEY.prod]
from = "awssm://eu-west-1/prod/stripe"
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

const PAIRED_MAP = `
[awssm]
account = "123456789012"

[keys.APP_SECRET.prod]
from = "awssm://eu-west-1/prod/app:SECRET"
publish = [{ to = "github-actions", repo = "acme/billing" }]

[keys.APP_SECRET.prod.issuer]
kind = "paired"
admin = "awssm://eu-west-1/prod/admin:RESEND"
key_id = "APP_KEY_ID"

[keys.APP_KEY_ID.prod]
from = "awssm://eu-west-1/prod/app:ID"
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

const ISSUER_MAP = `${MAP}
[keys.STRIPE_API_KEY.prod.issuer]
kind = "resend"
admin = "awssm://eu-west-1/prod/admin:RESEND"
permission = "sending_access"
`;

function world(): FakeSecretsManager {
  return {
    account: "123456789012",
    credentials: [KEY],
    secrets: {
      "eu-west-1/dev/billing": { value: JSON.stringify({ STRIPE_API_KEY: SENTINEL, PORT: "1" }) },
      "eu-west-1/prod/stripe": { value: `${SENTINEL}-prod`, created: "2026-08-01T10:00:00Z" },
      "eu-west-1/prod/admin": { value: JSON.stringify({ RESEND: `${SENTINEL}-admin` }) },
    },
  };
}

function project(
  options: { env?: Record<string, string>; map?: string; aws?: FakeSecretsManager } = {},
) {
  const disk = memoryFiles({
    "/work/billing/keypin.toml": options.map ?? MAP,
    [REGISTRY]: registryWith("/work/billing"),
  });
  const store = memorySecrets();
  const env = {
    PATH: "/usr/bin",
    AWS_ACCESS_KEY_ID: KEY.id,
    AWS_SECRET_ACCESS_KEY: KEY.secret,
    ...options.env,
  };
  const onePassword = fakeVault();
  const signIn = () =>
    onePasswordFrom(env, {
      desktop: async () => {
        throw new Error("this test opens no 1Password desktop app");
      },
      token: async () => {
        throw new Error("this test signs in with no service account");
      },
    });
  const aws = secretsManagerBackend(
    awsSignIn(env, "/home/me", () => null),
    {
      fetch: secretsManagerFetch(options.aws ?? world(), store),
      now: () => new Date("2026-11-09T12:00:00Z"),
    },
  );
  const launcher = fakeLauncher();
  const destinations = fakeDestinations();
  const issued: string[] = [];
  const issuer: Issuer = {
    describe: () => "Resend",
    dashboard: () => "https://resend.com/api-keys",
    checkAccount: async (current) => ({
      ok: true,
      facts: "the admin key lists 1 API key",
      ...(current ? { currentId: current } : {}),
    }),
    async create(name) {
      issued.push(`create ${name}`);
      return { id: "key-1", secret: new Secret(ISSUED) };
    },
    async revoke(id) {
      issued.push(`revoke ${id}`);
      return "revoked";
    },
  };
  const fake = fakeDeps({
    disk,
    backend: routedVault({
      "1password": () => (signIn(), onePassword.vault),
      awssm: () => aws,
    }),
    deps: {
      env,
      issuers: [...issuers, pairedKind],
      signIn: () => signIn().signIn,
      launch: launcher.launch,
      onSignals: launcher.onSignals,
      destination: destinations.build,
      issuer: () => issuer,
      isTerminal: true,
      ask: async () => "y",
    },
  });
  return { ...fake, launcher, destinations, store, onePassword, issued };
}

describe("keypin with AWS Secrets Manager", () => {
  test("run gives the command one key of a JSON secret, and passes AWS credentials through", async () => {
    const run = project();
    expect(await cli(["run", "--", "env"], run.deps)).toBe(0);
    expect(run.launcher.launches[0]?.env).toEqual({
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: KEY.id,
      AWS_SECRET_ACCESS_KEY: KEY.secret,
      STRIPE_API_KEY: SENTINEL,
    });
    expect(run.stderr.text).toContain(
      "Read 1 dev value from AWS account 123456789012 in eu-west-1  awssm://eu-west-1/dev/billing:STRIPE_API_KEY",
    );
    expect(run.onePassword.calls).toEqual([]);
  });

  test("run with no AWS credentials says what to set, and starts nothing", async () => {
    const run = project({ env: { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" } });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "AWS account 123456789012 in eu-west-1: sign-in failed: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
    );
    expect(run.launcher.launches).toEqual([]);
  });

  test("check names how keypin signs in, never the key, and looks up without reading values", async () => {
    const run = project();
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).toContain(
      "Note: keypin signs in to AWS with the credentials in AWS_ACCESS_KEY_ID\n",
    );
    expect(run.stderr.text).toContain(
      "Looked up 2 items in AWS account 123456789012 in eu-west-1, not the values",
    );
    expect(run.stdout.text + run.stderr.text).not.toContain(KEY.secret);
    expect(run.stdout.text + run.stderr.text).not.toContain(SENTINEL);
  });

  test("credentials from another account are one sign-in step", async () => {
    const other = { ...world(), credentials: [{ ...KEY, account: "999999999999" }] };
    const run = project({ aws: other });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text.split("Sign in to AWS")).toHaveLength(2);
    expect(run.stdout.text).toContain("Sign in to the AWS account keypin.toml pins under [awssm].");
    const json = project({ aws: other });
    expect(await cli(["check", "--json"], json.deps)).toBe(1);
    expect(parseJson(json.stdout.text)).toMatchObject({
      prerequisites: [{ name: "AWS", status: "sign-in failed" }],
    });
  });

  test("status reads the whole secret's date from its current version, and asks for a tag on a JSON key", async () => {
    const run = project();
    await cli(["status"], run.deps);
    expect(run.stdout.text).not.toContain("STRIPE_API_KEY (prod): no rotated date");
    expect(run.stdout.text).toContain(
      "STRIPE_API_KEY (dev): no rotated date\n    Tag the AWS secret with keypin-rotated:<JSON key>",
    );
  });

  test("publish reads the prod value and writes it to GitHub", async () => {
    const run = project();
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing",
      `write github-actions:acme/billing STRIPE_API_KEY (${SENTINEL.length + 5} chars)`,
    ]);
    expect(run.stderr.text).toContain(
      "STRIPE_API_KEY prod  from awssm://eu-west-1/prod/stripe in AWS account 123456789012 in eu-west-1",
    );
  });

  test("rotate saves the new key as a new version, reading the admin key from a JSON secret", async () => {
    const run = project({ map: ISSUER_MAP });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.store.effects).toEqual(["awssm put eu-west-1/prod/stripe"]);
    expect(run.store.load()["eu-west-1/prod/stripe"]?.value).toBe(ISSUED);
    expect(run.stderr.text).toContain(
      "AWS Secrets Manager  awssm://eu-west-1/prod/stripe  saved, rotated 2026-11-09",
    );
    expect(run.stderr.text + run.stdout.text).not.toContain(ISSUED);
  });

  test("rotate without PutSecretValue revokes the new key, and nothing changes", async () => {
    const run = project({ map: ISSUER_MAP, aws: { ...world(), denied: ["PutSecretValue"] } });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text + run.stdout.text).toContain(
      "the signed-in identity isn't allowed secretsmanager:PutSecretValue on the secret, or its KMS key",
    );
    expect(run.issued).toEqual([expect.stringMatching(/^create /), "revoke key-1"]);
    expect(run.store.effects).toEqual([]);
  });

  test("rotate stops before creating a key when Secrets Manager rotates the secret itself", async () => {
    const aws = world();
    const stripe = aws.secrets["eu-west-1/prod/stripe"];
    if (stripe) stripe.rotation = true;
    const run = project({ map: ISSUER_MAP, aws });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text + run.stdout.text).toContain(
      "Secrets Manager rotates this secret itself",
    );
    expect(run.issued).toEqual([]);
    expect(run.store.effects).toEqual([]);
  });

  test("a JSON key whose date tag fails stops rotate, and a second run resumes without a new key", async () => {
    const map = ISSUER_MAP.replace(
      'from = "awssm://eu-west-1/prod/stripe"',
      'from = "awssm://eu-west-1/prod/app:STRIPE"',
    );
    const aws = { ...world(), denied: ["TagResource"] };
    aws.secrets["eu-west-1/prod/app"] = { value: JSON.stringify({ STRIPE: `${SENTINEL}-p` }) };
    const run = project({ map, aws });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "keypin saved the new value, but couldn't set the tag keypin-rotated:STRIPE to 2026-11-09",
    );
    expect(run.destinations.log).toEqual(["check github-actions:acme/billing"]);
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain("and AWS Secrets Manager holds it");
    expect(run.issued).toEqual([expect.stringMatching(/^create /)]);
    expect(run.store.effects).toEqual(["awssm put eu-west-1/prod/app"]);
    expect(run.stderr.text + run.stdout.text).not.toContain(ISSUED);
  });

  test.each([
    ["current", 0, { SECRET: ISSUED, ID: "key-1" }, ["revoke key-0"]],
    ["current-and-new-versions", 1, { SECRET: ISSUED, ID: "key-0" }, []],
  ] as const)(
    "a paired rotation whose AWSCURRENT read is stale (%s) never leaves the old secret with the new ID",
    async (stale, code, saved, revoked) => {
      const aws: FakeSecretsManager = { ...world(), staleReads: stale };
      aws.secrets["eu-west-1/prod/app"] = {
        value: JSON.stringify({ SECRET: `${SENTINEL}-old`, ID: "key-0" }),
      };
      const run = project({ map: PAIRED_MAP, aws });
      expect(await cli(["rotate", "APP_SECRET"], run.deps)).toBe(code);
      expect(parseJson(run.store.load()["eu-west-1/prod/app"]?.value ?? "")).toEqual(saved);
      expect(run.issued.filter((line) => line.startsWith("revoke"))).toEqual(revoked);
      expect(run.stderr.text + run.stdout.text).not.toContain(ISSUED);
    },
  );
});
