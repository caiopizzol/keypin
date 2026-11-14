import { describe, expect, test } from "vite-plus/test";
import { infisicalBackend } from "@keypin/vault-infisical";
import { cli } from "../src/cli";
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
import { type FakeInfisical, infisicalFetch, memoryStore } from "./infisical-fake";

const CREDENTIALS = {
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "client-id-1",
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "client-secret-sentinel-9c1d",
};

const MAP = `
[infisical]
organization = "acme"

[keys.STRIPE_API_KEY]
rotate_every = "90d"
dev = "infisical://billing/dev/STRIPE_API_KEY"
prod = { from = "infisical://billing/prod/STRIPE_API_KEY", publish = [
  { to = "github-actions", repo = "acme/billing" },
] }
`;

const INFISICAL: FakeInfisical = {
  organization: "acme",
  projects: {
    billing: {
      dev: { STRIPE_API_KEY: { value: SENTINEL, rotated: "2026-10-01" } },
      prod: { STRIPE_API_KEY: { value: `${SENTINEL}-prod`, rotated: "2026-08-01" } },
    },
  },
};

function project(
  options: { env?: Record<string, string>; map?: string; infisical?: FakeInfisical } = {},
) {
  const disk = memoryFiles({
    "/work/billing/keypin.toml": options.map ?? MAP,
    [REGISTRY]: registryWith("/work/billing"),
  });
  const store = memoryStore();
  const env = { PATH: "/usr/bin", ...CREDENTIALS, ...options.env };
  const onePassword = fakeVault();
  const infisical = infisicalBackend(
    env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
      ? {
          clientId: env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID ?? "",
          clientSecret: env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET,
        }
      : null,
    infisicalFetch(options.infisical ?? INFISICAL, store),
  );
  const launcher = fakeLauncher();
  const destinations = fakeDestinations();
  const fake = fakeDeps({
    disk,
    backend: routedVault({ "1password": () => onePassword.vault, infisical: () => infisical }),
    deps: {
      env,
      launch: launcher.launch,
      onSignals: launcher.onSignals,
      destination: destinations.build,
      isTerminal: true,
      ask: async () => "y",
    },
  });
  return { ...fake, launcher, destinations, store, onePassword };
}

describe("keypin with Infisical", () => {
  test("run gives the command the dev value, never the Infisical credentials", async () => {
    const run = project();
    expect(await cli(["run", "--", "env"], run.deps)).toBe(0);
    expect(run.launcher.launches[0]?.env).toEqual({ PATH: "/usr/bin", STRIPE_API_KEY: SENTINEL });
    expect(run.stderr.text).toContain(
      "Read 1 dev value from Infisical organization acme at https://app.infisical.com  infisical://billing/dev/STRIPE_API_KEY",
    );
    expect(run.stderr.text).not.toContain("1Password may be asking");
    expect(run.onePassword.calls).toEqual([]);
  });

  test("run without credentials names the variables, and starts nothing", async () => {
    const run = project({ env: { INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "" } });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "sign-in failed: set INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    );
    expect(run.launcher.launches).toEqual([]);
  });

  test("a key named after an Infisical credential is refused", async () => {
    const map = `${MAP}\n[keys.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET]\nrotate_every = "never"\ndev = "infisical://billing/dev/STRIPE_API_KEY"\n`;
    const run = project({ map });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "keypin.toml maps INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, which keypin uses to sign in to your vault",
    );
  });

  test("status reads the rotated date from the secret's metadata", async () => {
    const run = project();
    expect(await cli(["status", "--json"], run.deps)).toBe(1);
    const status = parseJson(run.stdout.text);
    expect(status).toMatchObject({
      rows: [
        { keyId: "STRIPE_API_KEY", environment: "dev", rotated: "2026-10-01", due: "2026-12-30" },
        { keyId: "STRIPE_API_KEY", environment: "prod", rotated: "2026-08-01", due: "2026-10-30" },
      ],
    });
    expect(run.stderr.text).toContain(
      "Read 2 rotated dates from Infisical organization acme at https://app.infisical.com, not the values",
    );
  });

  test("status tells how to set the rotated metadata when it's missing", async () => {
    const run = project({
      infisical: {
        ...INFISICAL,
        projects: {
          billing: { ...INFISICAL.projects.billing, dev: { STRIPE_API_KEY: { value: SENTINEL } } },
        },
      },
    });
    await cli(["status"], run.deps);
    expect(run.stdout.text).toContain(
      "Add rotated to the Infisical secret's metadata, with the day the value last changed as YYYY-MM-DD.",
    );
  });

  test("publish reads the prod value from Infisical and writes it to GitHub", async () => {
    const run = project();
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing",
      `write github-actions:acme/billing STRIPE_API_KEY (${SENTINEL.length + 5} chars)`,
    ]);
    expect(run.stderr.text).toContain(
      "STRIPE_API_KEY prod  from infisical://billing/prod/STRIPE_API_KEY in Infisical organization acme at https://app.infisical.com",
    );
    expect(run.stderr.text).not.toContain(SENTINEL);
  });

  test("check looks the secrets up, and a wrong organization is one sign-in step", async () => {
    const ok = project();
    await cli(["check"], ok.deps);
    expect(ok.stderr.text).toContain(
      "Looked up 2 items in Infisical organization acme at https://app.infisical.com, not the values",
    );
    const other = project({ infisical: { ...INFISICAL, organization: "other" } });
    expect(await cli(["check"], other.deps)).toBe(1);
    expect(other.stdout.text).toContain("Sign in to Infisical");
    expect(other.stdout.text).toContain(
      "Use a machine identity from the organization keypin.toml pins under [infisical].",
    );
    expect(other.stdout.text).not.toContain("1Password");
  });

  test("import says it creates 1Password items when the map reads from Infisical", async () => {
    const run = project();
    run.disk.contents.set("/work/billing/.env", "RESEND_KEY=resend-value-1234\n");
    expect(await cli(["import", ".env", "--vault", "Private", "--yes"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "import creates 1Password items, and /work/billing/keypin.toml reads from Infisical; add the secrets in Infisical and map them with infisical:// references (docs/infisical.md)",
    );
    expect(run.store.effects).toEqual([]);
  });
});
