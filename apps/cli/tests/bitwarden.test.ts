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
  fakeLauncher,
  fakeVault,
  memoryFiles,
  parseJson,
  REGISTRY,
  registryWith,
  SENTINEL,
} from "./fakes";

const ORGANIZATION = "2f1d6c9e-8a3b-4c5d-9e7f-0a1b2c3d4e5f";
const WHERE = `Bitwarden organization ${ORGANIZATION} at https://vault.bitwarden.com`;

const MAP = `
[bitwarden]
organization = "${ORGANIZATION}"

[keys.STRIPE_API_KEY]
rotate_every = "90d"
dev = "bitwarden://billing-dev/STRIPE_API_KEY"
prod = { from = "bitwarden://billing/STRIPE_API_KEY", publish = [
  { to = "github-actions", repo = "acme/billing" },
] }
`;

const ISSUER_MAP = `
[bitwarden]
organization = "${ORGANIZATION}"

[keys.STRIPE_API_KEY]
rotate_every = "90d"

[keys.STRIPE_API_KEY.prod]
from = "bitwarden://billing/STRIPE_API_KEY"
publish = [{ to = "github-actions", repo = "acme/billing" }]

[keys.STRIPE_API_KEY.prod.issuer]
kind = "resend"
admin = "bitwarden://billing/RESEND_ADMIN_KEY"
permission = "sending_access"
`;

const ISSUED = "re_issued_sentinel_value_7b3d";

const bitwarden = (): FakeBitwarden => ({
  organization: ORGANIZATION,
  projects: {
    "billing-dev": {
      secrets: [{ name: "STRIPE_API_KEY", value: SENTINEL, note: "rotated: 2026-10-01" }],
    },
    billing: {
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
    "/work/billing/keypin.toml": options.map ?? MAP,
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
  const launcher = fakeLauncher();
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

describe("keypin with Bitwarden Secrets Manager", () => {
  test("run gives the command the dev value, never the access token", async () => {
    const run = project();
    expect(await cli(["run", "--", "env"], run.deps)).toBe(0);
    expect(run.launcher.launches[0]?.env).toEqual({ PATH: "/usr/bin", STRIPE_API_KEY: SENTINEL });
    expect(run.stderr.text).toContain(
      `Read 1 dev value from ${WHERE}  bitwarden://billing-dev/STRIPE_API_KEY`,
    );
    expect(run.onePassword.calls).toEqual([]);
  });

  test("run without an access token names the variable, and starts nothing", async () => {
    const run = project({ env: { BWS_ACCESS_TOKEN: "" } });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "sign-in failed: set BWS_ACCESS_TOKEN to a machine account's access token",
    );
    expect(run.launcher.launches).toEqual([]);
  });

  test("a key named BWS_ACCESS_TOKEN is refused", async () => {
    const map = `${MAP}\n[keys.BWS_ACCESS_TOKEN]\nrotate_every = "never"\ndev = "bitwarden://billing-dev/STRIPE_API_KEY"\n`;
    const run = project({ map });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "keypin.toml maps BWS_ACCESS_TOKEN, which keypin uses to sign in",
    );
  });

  test("a map without an organization ID is refused with the fix", async () => {
    const run = project({ map: MAP.replace(ORGANIZATION, "acme") });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(`field "organization" must be your organization's ID`);
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
    fake.projects["billing-dev"] = { secrets: [{ name: "STRIPE_API_KEY", value: SENTINEL }] };
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
      `STRIPE_API_KEY prod  from bitwarden://billing/STRIPE_API_KEY in ${WHERE}`,
    );
    expect(run.stderr.text).not.toContain(SENTINEL);
  });

  test("check looks the secrets up, and a wrong organization is one sign-in step", async () => {
    const ok = project();
    expect(await cli(["check"], ok.deps)).toBe(0);
    expect(ok.stderr.text).toContain(`Looked up 2 items in ${WHERE}, not the values`);
    const fake = { ...bitwarden(), organization: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b" };
    const other = project({ fake });
    expect(await cli(["check"], other.deps)).toBe(1);
    expect(other.stdout.text.split("Sign in to Bitwarden")).toHaveLength(2);
    expect(other.stdout.text).toContain(
      "Use an access token from a machine account in the organization keypin.toml pins under [bitwarden].",
    );
    expect(other.stdout.text).not.toContain("1Password");
  });

  test.each([["run", "--", "env"], ["check"], ["status"], ["publish", "STRIPE_API_KEY"]])(
    "%s never needs 1Password when every key is in Bitwarden",
    async (...command) => {
      const run = project({ env: { KEYPIN_1PASSWORD: "service-account" } });
      await cli(command, run.deps);
      expect(run.stderr.text + run.stdout.text).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
      expect(run.onePassword.calls).toEqual([]);
    },
  );

  test("check says to add an env file's key in Bitwarden, not to import it", async () => {
    const map = MAP.replace('dev = "bitwarden://billing-dev/STRIPE_API_KEY"\n', "");
    const run = project({ map });
    run.disk.contents.set("/work/billing/.env", `STRIPE_API_KEY=${SENTINEL}\n`);
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).not.toContain("keypin import");
    expect(run.stdout.text).toContain(
      "add the secrets in Bitwarden Secrets Manager and map them with bitwarden:// references (docs/bitwarden.md)",
    );
  });

  test("import says it creates 1Password items when the map reads from Bitwarden", async () => {
    const run = project();
    run.disk.contents.set("/work/billing/.env", "RESEND_KEY=resend-value-1234\n");
    expect(await cli(["import", ".env", "--vault", "Private", "--yes"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "import creates 1Password items, and /work/billing/keypin.toml reads from Bitwarden; add the secrets in Bitwarden Secrets Manager and map them with bitwarden:// references (docs/bitwarden.md)",
    );
    expect(run.store.effects).toEqual([]);
  });

  test("rotate saves the new key in the secret, with today in its note", async () => {
    const run = project({ map: ISSUER_MAP });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.issued).toEqual(["create STRIPE_API_KEY prod 2026-11-09 12:00:00 a1b2c3"]);
    expect(run.store.effects).toEqual(["bitwarden update STRIPE_API_KEY"]);
    expect(run.store.load()[0]).toMatchObject({
      value: ISSUED,
      note: "owner: payments\nrotated: 2026-11-09",
    });
    expect(run.stderr.text).toContain(
      "Bitwarden  bitwarden://billing/STRIPE_API_KEY  saved, rotated 2026-11-09",
    );
    expect(run.stderr.text + run.stdout.text).not.toContain(ISSUED);
    expect(run.onePassword.calls).toEqual([]);
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
