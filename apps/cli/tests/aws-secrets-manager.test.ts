import { describe, expect, test } from "vite-plus/test";
import { type IdToken, type Issuer, NoIdToken, Secret } from "@keypin/core";
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
const WHERE = "AWS in eu-west-1";

const HEAD = `[project]
name = "billing"
revision = "1.0"

[providers]
aws = "awssm://eu-west-1"

[defaults]
providers = ["aws"]
`;

const MAP = `${HEAD}
[profiles.dev]
STRIPE_API_KEY = { description = "Stripe", ref = { item = "dev/billing", field = "STRIPE_API_KEY" } }

[profiles.prod]
STRIPE_API_KEY = { description = "Stripe" }

[tool.keypin.dev.STRIPE_API_KEY]
rotate_every = "90d"

[tool.keypin.prod.STRIPE_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

const PROD = "secretspec/billing/prod/STRIPE_API_KEY";

const ISSUER_MAP = `${MAP}issuer = { kind = "resend", admin = "awssm://eu-west-1/prod/admin:RESEND", permission = "sending_access" }
`;

const PAIRED_MAP = `${HEAD}
[profiles.prod]
APP_SECRET = { description = "App secret", ref = { item = "prod/app", field = "SECRET" } }
APP_KEY_ID = { description = "App key ID", ref = { item = "prod/app", field = "ID" } }

[tool.keypin.prod.APP_SECRET]
publish = [{ to = "github-actions", repo = "acme/billing" }]
issuer = { kind = "paired", admin = "awssm://eu-west-1/prod/admin:RESEND", key_id = "APP_KEY_ID" }

[tool.keypin.prod.APP_KEY_ID]
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

function world(): FakeSecretsManager {
  return {
    account: "123456789012",
    credentials: [KEY],
    secrets: {
      "eu-west-1/dev/billing": { value: JSON.stringify({ STRIPE_API_KEY: SENTINEL, PORT: "1" }) },
      [`eu-west-1/${PROD}`]: { value: `${SENTINEL}-prod`, created: "2026-08-01T10:00:00Z" },
      "eu-west-1/prod/admin": { value: JSON.stringify({ RESEND: `${SENTINEL}-admin` }) },
    },
  };
}

function project(
  options: {
    env?: Record<string, string>;
    map?: string;
    aws?: FakeSecretsManager;
    idToken?: IdToken;
  } = {},
) {
  const disk = memoryFiles({
    "/work/billing/secretspec.toml": options.map ?? MAP,
    [REGISTRY]: registryWith("/work/billing"),
  });
  const store = memorySecrets();
  const env = Object.fromEntries(
    Object.entries({
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: KEY.id,
      AWS_SECRET_ACCESS_KEY: KEY.secret,
      ...options.env,
    }).filter(([, value]) => value !== ""),
  );
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
      ...(options.idToken ? { idToken: options.idToken } : {}),
    },
  );
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
      destination: destinations.build,
      issuer: () => issuer,
      isTerminal: true,
      ask: async () => "y",
    },
  });
  return { ...fake, destinations, store, onePassword, issued };
}

describe("keypin with AWS Secrets Manager", () => {
  test("check with no AWS credentials says what to set, as the sign-in step", async () => {
    const run = project({ env: { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" } });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text.split("Sign in to AWS")).toHaveLength(2);
    expect(run.stdout.text).toContain("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
  });

  test("check names how keypin signs in, never the key, and looks up without reading values", async () => {
    const run = project();
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).toContain(
      "Note: keypin signs in to AWS with the credentials in AWS_ACCESS_KEY_ID\n",
    );
    expect(run.stderr.text).toContain(`Looked up 2 items in ${WHERE}, not the values`);
    expect(run.stdout.text + run.stderr.text).not.toContain(KEY.secret);
    expect(run.stdout.text + run.stderr.text).not.toContain(SENTINEL);
  });

  test("credentials from any account sign in: keypin checks none", async () => {
    const run = project({
      aws: { ...world(), credentials: [{ ...KEY, account: "999999999999" }] },
    });
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).not.toContain("Sign in to AWS");
  });

  test("a provider with an AWS profile is refused, since keypin signs in from its environment", async () => {
    const run = project({ map: MAP.replace("awssm://eu-west-1", "awssm://work@eu-west-1") });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    expect(JSON.stringify(parseJson(run.stdout.text))).toContain(
      "uses awssm://work@eu-west-1, which names an AWS profile; keypin signs in only with the credentials in its environment, so drop the profile from the provider and set AWS_PROFILE where keypin runs",
    );
  });

  test("status reads the whole secret's date from its current version, and asks for a tag on a JSON key", async () => {
    const run = project();
    await cli(["status"], run.deps);
    expect(run.stdout.text).not.toContain("STRIPE_API_KEY (prod): no rotated date");
    expect(run.stdout.text).toContain(
      "STRIPE_API_KEY (dev): no rotated date\n    Tag the AWS secret with keypin-rotated:<JSON key>",
    );
  });

  test("publish reads secretspec's own prod secret and writes it to GitHub", async () => {
    const run = project();
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing",
      `write github-actions:acme/billing STRIPE_API_KEY (${SENTINEL.length + 5} chars)`,
    ]);
    expect(run.stderr.text).toContain(
      `STRIPE_API_KEY prod  from awssm://eu-west-1/${PROD} in ${WHERE}`,
    );
  });

  test("check says to declare an env file's key and set it in AWS, not to import it", async () => {
    const run = project();
    run.disk.contents.set("/work/billing/.env", `RESEND_KEY=${SENTINEL}\n`);
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).not.toContain("keypin import");
    expect(run.stdout.text).toContain(
      "declare the secrets in secretspec.toml, then save each value in AWS Secrets Manager with secretspec set (docs/integrations/vaults/aws-secrets-manager.md)",
    );
  });

  test("rotate saves the new key as a new version, reading the admin key from a JSON secret", async () => {
    const run = project({ map: ISSUER_MAP });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.store.effects).toEqual([`awssm put eu-west-1/${PROD}`]);
    expect(run.store.load()[`eu-west-1/${PROD}`]?.value).toBe(ISSUED);
    expect(run.stderr.text).toContain(
      `AWS Secrets Manager  awssm://eu-west-1/${PROD}  saved, rotated 2026-11-09`,
    );
    expect(run.stderr.text + run.stdout.text).not.toContain(ISSUED);
  });

  test("rotate stops before creating a key when secretspec's secret doesn't exist yet", async () => {
    const aws = world();
    delete aws.secrets[`eu-west-1/${PROD}`];
    const run = project({ map: ISSUER_MAP, aws });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `no secret ${PROD} in eu-west-1 (AWS GetSecretValue returned HTTP 400 ResourceNotFoundException); check the region and the name; keypin doesn't create a secret, so save it first, such as with secretspec set`,
    );
    expect(run.issued).toEqual([]);
    expect(run.store.effects).toEqual([]);
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
    const stripe = aws.secrets[`eu-west-1/${PROD}`];
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
      '[profiles.prod]\nSTRIPE_API_KEY = { description = "Stripe" }',
      '[profiles.prod]\nSTRIPE_API_KEY = { description = "Stripe", ref = { item = "prod/app", field = "STRIPE" } }',
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

  describe("signed in with GitHub Actions OIDC", () => {
    const ROLE = "arn:aws:iam::123456789012:role/keypin-read";
    const JWT = "github-jwt-sentinel-0e3d";
    const MINTED = {
      id: "ASIAMINTEDMINTED0001",
      secret: "minted-secret-sentinel-6b2c",
      token: "minted-session-sentinel-8f1a",
    };
    const OIDC = {
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      KEYPIN_AWS_ROLE_ARN: ROLE,
      KEYPIN_AWS_AUDIENCE: "sts.amazonaws.com",
    };
    const oidcWorld = (): FakeSecretsManager => ({
      ...world(),
      webIdentity: { role: ROLE, jwt: JWT, minted: MINTED },
    });
    const idToken: IdToken = async () => JWT;
    const hidesSecrets = (text: string) => {
      for (const secret of [JWT, MINTED.secret, MINTED.token]) expect(text).not.toContain(secret);
    };

    test("check says how it signs in", async () => {
      const run = project({ env: OIDC, aws: oidcWorld(), idToken });
      expect(await cli(["check"], run.deps)).toBe(0);
      expect(run.stdout.text).toContain(
        "Note: keypin signs in to AWS with GitHub Actions OIDC, as the role in KEYPIN_AWS_ROLE_ARN\n",
      );
      hidesSecrets(run.stdout.text + run.stderr.text);
    });

    test("check without a job token gives the fix as the sign-in step", async () => {
      const noJob: IdToken = () => Promise.reject(new NoIdToken("this job can't ask for a token"));
      const run = project({ env: OIDC, aws: oidcWorld(), idToken: noJob });
      expect(await cli(["check"], run.deps)).toBe(1);
      expect(run.stdout.text).toContain(
        "Give the GitHub Actions job permissions: id-token: write, or unset KEYPIN_AWS_ROLE_ARN to sign in another way.",
      );
    });

    test("check after STS refuses the token points at the role's trust policy", async () => {
      const refused = { ...oidcWorld(), webIdentity: { role: "other", jwt: JWT, minted: MINTED } };
      const run = project({ env: OIDC, aws: refused, idToken });
      expect(await cli(["check"], run.deps)).toBe(1);
      expect(run.stdout.text).toContain(
        "Check KEYPIN_AWS_ROLE_ARN, KEYPIN_AWS_AUDIENCE and the role's trust policy (docs/integrations/vaults/aws-secrets-manager.md).",
      );
      hidesSecrets(run.stdout.text + run.stderr.text);
    });
  });
});
