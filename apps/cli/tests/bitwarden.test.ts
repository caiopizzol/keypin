import { describe, expect, test } from "vite-plus/test";
import { type Issuer, Secret } from "@keypin/core";
import { accessTokenFrom, bitwardenBackend } from "@keypin/connectors/bitwarden";
import {
  bitwardenFetch,
  FAKE_ACCESS_TOKEN,
  type FakeBitwarden,
  memoryStore,
} from "@keypin/connectors/bitwarden/testing";
import { cli } from "../src/cli";
import { onePasswordFrom } from "../src/sign-in";
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

const ORGANIZATION = "2f1d6c9e-8a3b-4c5d-9e7f-0a1b2c3d4e5f";
const DEV = "a1b2c3d4-0000-4000-8000-000000000001";
const PROD = "a9230ec4-5507-4870-b8b5-b3f500587e4c";
const WHERE = "Bitwarden at https://vault.bitwarden.com";

const HEAD = `[project]
name = "billing"
revision = "1.0"

[providers]
bw_dev = "bws://${DEV}"
bw = "bws://${PROD}"

[profiles.dev.defaults]
providers = ["bw_dev"]

[profiles.prod.defaults]
providers = ["bw"]
`;

const MAP = `${HEAD}
[profiles.dev]
STRIPE_API_KEY = { description = "Stripe" }

[profiles.prod]
STRIPE_API_KEY = { description = "Stripe" }

[tool.keypin.dev.STRIPE_API_KEY]
rotate_every = "90d"

[tool.keypin.prod.STRIPE_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

const ISSUER_MAP = `${MAP}issuer = { kind = "resend", admin = "bitwarden://${PROD}/RESEND_ADMIN_KEY", permission = "sending_access" }
`;

const ISSUED = "re_issued_sentinel_value_7b3d";

const bitwarden = (): FakeBitwarden => ({
  organization: ORGANIZATION,
  projects: {
    "billing-dev": {
      id: DEV,
      secrets: [{ name: "STRIPE_API_KEY", value: SENTINEL, note: "rotated: 2026-10-01" }],
    },
    billing: {
      id: PROD,
      secrets: [
        {
          name: "STRIPE_API_KEY",
          value: `${SENTINEL}-prod`,
          note: "owner: payments\nrotated: 2026-08-01",
        },
        { name: "RESEND_ADMIN_KEY", value: `${SENTINEL}-admin` },
      ],
    },
  },
});

function project(
  options: { env?: Record<string, string>; map?: string; fake?: FakeBitwarden } = {},
) {
  const disk = memoryFiles({
    "/work/billing/secretspec.toml": options.map ?? MAP,
    [REGISTRY]: registryWith("/work/billing"),
  });
  const store = memoryStore();
  const env = { PATH: "/usr/bin", BWS_ACCESS_TOKEN: FAKE_ACCESS_TOKEN, ...options.env };
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
  const vault = bitwardenBackend(
    accessTokenFrom(env),
    bitwardenFetch(options.fake ?? bitwarden(), store),
  );
  const destinations = fakeDestinations({ failWrite: [] });
  const issued: string[] = [];
  const issuer: Issuer = {
    describe: () => "Resend",
    dashboard: () => "https://resend.com/api-keys",
    checkAccount: async () => ({ ok: true, facts: "the admin key lists 1 API key" }),
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
      bitwarden: () => vault,
    }),
    deps: {
      env,
      signIn: () => signIn().signIn,
      destination: destinations.build,
      issuer: () => issuer,
      isTerminal: true,
      ask: async () => "y",
    },
  });
  return { ...fake, destinations, store, onePassword, issued };
}

describe("keypin with Bitwarden Secrets Manager", () => {
  test("check without an access token names the variable as the sign-in step", async () => {
    const run = project({ env: { BWS_ACCESS_TOKEN: "" } });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text.split("Sign in to Bitwarden")).toHaveLength(2);
    expect(run.stdout.text).toContain("Set BWS_ACCESS_TOKEN to a machine account's access token");
  });

  test("check looks the secrets up in each profile's project, for any organization", async () => {
    const ok = project();
    expect(await cli(["check"], ok.deps)).toBe(0);
    expect(ok.stderr.text).toContain(`Looked up 2 items in ${WHERE}, not the values`);
    const other = project({
      fake: { ...bitwarden(), organization: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b" },
    });
    expect(await cli(["check"], other.deps)).toBe(0);
    expect(other.stdout.text).not.toContain("1Password");
  });

  test("a bw:// provider is the Password Manager, and check points to bws://", async () => {
    const run = project({ map: MAP.replace(`bw = "bws://${PROD}"`, `bw = "bw://Billing"`) });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      "[profiles.prod] STRIPE_API_KEY: uses bw://Billing; keypin's Bitwarden vault is Secrets Manager, not the Password Manager, so write bws://<project ID>",
    );
  });

  test("two profiles on one bws:// provider read one secret, as secretspec does", async () => {
    const map = MAP.replace(`bw_dev = "bws://${DEV}"`, `bw_dev = "bws://${PROD}"`);
    const run = project({ map });
    expect(await cli(["status", "--json"], run.deps)).toBe(1);
    expect(parseJson(run.stdout.text)).toMatchObject({
      rows: [
        { keyId: "STRIPE_API_KEY", environment: "dev", rotated: "2026-08-01" },
        { keyId: "STRIPE_API_KEY", environment: "prod", rotated: "2026-08-01" },
      ],
    });
  });

  test("status reads the rotated date from the secret's note", async () => {
    const run = project();
    expect(await cli(["status", "--json"], run.deps)).toBe(1);
    expect(parseJson(run.stdout.text)).toMatchObject({
      rows: [
        { keyId: "STRIPE_API_KEY", environment: "dev", rotated: "2026-10-01" },
        { keyId: "STRIPE_API_KEY", environment: "prod", rotated: "2026-08-01" },
      ],
    });
    expect(run.stderr.text).toContain(`Read 2 rotated dates from ${WHERE}, not the values`);
  });

  test("status tells how to add the rotated line when the note has none", async () => {
    const fake = bitwarden();
    fake.projects["billing-dev"] = {
      id: DEV,
      secrets: [{ name: "STRIPE_API_KEY", value: SENTINEL }],
    };
    const run = project({ fake });
    await cli(["status"], run.deps);
    expect(run.stdout.text).toContain(
      "Add a line rotated: YYYY-MM-DD to the Bitwarden secret's note, with the day the value last changed.",
    );
  });

  test("publish reads the prod value from Bitwarden and writes it to GitHub", async () => {
    const run = project();
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing",
      `write github-actions:acme/billing STRIPE_API_KEY (${SENTINEL.length + 5} chars)`,
    ]);
    expect(run.stderr.text).toContain(
      `STRIPE_API_KEY prod  from bitwarden://${PROD}/STRIPE_API_KEY in ${WHERE}`,
    );
    expect(run.stderr.text).not.toContain(SENTINEL);
  });

  test("publish reads a ref's secret by its own name", async () => {
    const map = MAP.replace(
      '[profiles.prod]\nSTRIPE_API_KEY = { description = "Stripe" }',
      '[profiles.prod]\nSTRIPE_API_KEY = { description = "Stripe", ref = { item = "RESEND_ADMIN_KEY" } }',
    );
    const run = project({ map });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.destinations.log).toContain(
      `write github-actions:acme/billing STRIPE_API_KEY (${SENTINEL.length + 6} chars)`,
    );
  });

  test.each([["check"], ["status"], ["publish", "STRIPE_API_KEY"]])(
    "%s never needs 1Password when every key is in Bitwarden",
    async (...command) => {
      const run = project({ env: { KEYPIN_1PASSWORD: "service-account" } });
      await cli(command, run.deps);
      expect(run.stderr.text + run.stdout.text).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
      expect(run.onePassword.calls).toEqual([]);
    },
  );

  test("check says to declare an env file's key and set it in Bitwarden, not to import it", async () => {
    const run = project();
    run.disk.contents.set("/work/billing/.env", `RESEND_KEY=${SENTINEL}\n`);
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).not.toContain("keypin import");
    expect(run.stdout.text).toContain(
      "declare the secrets in secretspec.toml, then save each value in Bitwarden Secrets Manager with secretspec set (docs/integrations/vaults/bitwarden.md)",
    );
  });

  test("rotate saves the new key in the secret, with today in its note", async () => {
    const run = project({ map: ISSUER_MAP });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.issued).toEqual(["create billing-stripe-api-key-prod-a1b2c3"]);
    expect(run.store.effects).toEqual(["bitwarden update STRIPE_API_KEY"]);
    expect(run.store.load()[0]).toMatchObject({
      value: ISSUED,
      note: "owner: payments\nrotated: 2026-11-09",
    });
    expect(run.stderr.text).toContain(
      `Bitwarden  bitwarden://${PROD}/STRIPE_API_KEY  saved, rotated 2026-11-09`,
    );
    expect(run.stderr.text + run.stdout.text).not.toContain(ISSUED);
    expect(run.onePassword.calls).toEqual([]);
  });

  test("rotate stops before creating a key when the secret doesn't exist yet", async () => {
    const fake = bitwarden();
    const billing = fake.projects.billing;
    if (billing) billing.secrets = billing.secrets.filter((s) => s.name !== "STRIPE_API_KEY");
    const run = project({ map: ISSUER_MAP, fake });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stdout.text + run.stderr.text).toContain(
      "no secret named STRIPE_API_KEY in the project, or the machine account can't read it; keypin doesn't create one, so save it first, such as with secretspec set",
    );
    expect(run.issued).toEqual([]);
    expect(run.store.effects).toEqual([]);
  });

  test("rotate with a read-only machine account stops before creating a key", async () => {
    const fake = bitwarden();
    const billing = fake.projects.billing;
    if (billing) billing.readOnly = true;
    const run = project({ map: ISSUER_MAP, fake });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stdout.text + run.stderr.text).toContain(
      "the machine account can read this secret but not change it; give it Can read, write on the project",
    );
    expect(run.issued).toEqual([]);
    expect(run.store.effects).toEqual([]);
  });
});
