import { describe, expect, test } from "vite-plus/test";
import { type IdToken, type Issuer, Secret } from "@keypin/core";
import { credentialsFrom, dopplerBackend } from "@keypin/connectors/doppler";
import {
  dopplerFetch,
  type FakeDoppler,
  type FakeToken,
  memoryStore,
} from "@keypin/connectors/doppler/testing";
import { cli } from "../src/cli";
import { onePasswordFrom } from "../src/sign-in";
import { routedVault } from "../src/vault";
import {
  fakeDeps,
  fakeDestinations,
  fakeVault,
  type FakeVaultOptions,
  memoryFiles,
  parseJson,
  REGISTRY,
  registryWith,
  SENTINEL,
} from "./fakes";

const SERVICE_TOKEN = "dp.st.prd.sentinel-token-7c2e";
const ACCOUNT_TOKEN = "dp.sa.sentinel-account-4f1b";
const ISSUED = "re_issued_sentinel_value_8d3a";

const MAP = `[project]
name = "billing"
revision = "1.0"

[providers]
doppler = "doppler://billing"
doppler_prd = "doppler://billing/prd"

[defaults]
providers = ["doppler"]

[profiles.dev]
STRIPE_API_KEY = { description = "Stripe" }

[profiles.prod.defaults]
providers = ["doppler_prd"]

[profiles.prod]
STRIPE_API_KEY = { description = "Stripe" }

[tool.keypin.prod.STRIPE_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

const ISSUER_MAP = `${MAP}issuer = { kind = "resend", admin = "doppler://billing/prd/RESEND_ADMIN_KEY", permission = "sending_access" }
`;

function world(tokens: Record<string, FakeToken> = {}): FakeDoppler {
  return {
    workplace: "acme",
    projects: {
      billing: {
        dev: { STRIPE_API_KEY: { value: SENTINEL } },
        prd: {
          STRIPE_API_KEY: { value: `${SENTINEL}-prod` },
          RESEND_ADMIN_KEY: { value: `${SENTINEL}-admin` },
        },
      },
    },
    tokens: {
      [SERVICE_TOKEN]: {
        type: "service_token",
        project: "billing",
        config: "prd",
        access: "read/write",
      },
      [ACCOUNT_TOKEN]: { type: "service_account", write: true },
      ...tokens,
    },
  };
}

function project(
  options: {
    env?: Record<string, string>;
    map?: string;
    doppler?: FakeDoppler;
    idToken?: IdToken;
    onePassword?: FakeVaultOptions;
  } = {},
) {
  const disk = memoryFiles({
    "/work/billing/secretspec.toml": options.map ?? MAP,
    [REGISTRY]: registryWith("/work/billing"),
  });
  const store = memoryStore();
  const env = { PATH: "/usr/bin", DOPPLER_TOKEN: ACCOUNT_TOKEN, ...options.env };
  const onePassword = fakeVault(options.onePassword);
  const signIn = () =>
    onePasswordFrom(env, {
      desktop: async () => {
        throw new Error("this test opens no 1Password desktop app");
      },
      token: async () => {
        throw new Error("this test signs in with no service account");
      },
    });
  const events: string[] = [];
  const served = dopplerFetch(options.doppler ?? world(), store);
  const doppler = dopplerBackend(
    credentialsFrom(env),
    (url, init) => {
      events.push(`${init.method} ${new URL(url).pathname}`);
      return served(url, init);
    },
    options.idToken ? { idToken: options.idToken } : {},
  );
  const destinations = fakeDestinations();
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
      doppler: () => doppler,
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
  return { ...fake, destinations, store, onePassword, issued, events };
}

describe("keypin with Doppler", () => {
  test("check without DOPPLER_TOKEN says what to set, as the sign-in step", async () => {
    const run = project({ env: { DOPPLER_TOKEN: "" } });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text.split("Sign in to Doppler")).toHaveLength(2);
    expect(run.stdout.text).toContain("Set DOPPLER_TOKEN to a Doppler service token");
    expect(run.events).toEqual([]);
  });

  test("check names the token kind, never the token, and looks up without reading values", async () => {
    const run = project();
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).toContain(
      "Note: keypin signs in to Doppler with the service account token in DOPPLER_TOKEN\n",
    );
    expect(run.stderr.text).toContain("Looked up 2 items in Doppler, not the values");
    expect(run.events).not.toContain("GET /v3/configs/config/secret");
    expect(run.stdout.text + run.stderr.text).not.toContain(ACCOUNT_TOKEN);
    expect(run.stdout.text + run.stderr.text).not.toContain(SENTINEL);
  });

  test("a token from any workplace signs in: keypin checks none", async () => {
    const run = project({ doppler: { ...world(), workplace: "globex" } });
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).not.toContain("Sign in to Doppler");
  });

  test("a revoked token is one sign-in step", async () => {
    const run = project({ env: { DOPPLER_TOKEN: "dp.sa.revoked-0000" } });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    expect(parseJson(run.stdout.text)).toMatchObject({
      onePassword: null,
      prerequisites: [{ name: "Doppler", status: "sign-in failed" }],
    });
  });

  test("a service token for prd can't read dev, and says why", async () => {
    const run = project({ env: { DOPPLER_TOKEN: SERVICE_TOKEN } });
    expect(await cli(["status"], run.deps)).toBe(1);
    expect(run.stdout.text + run.stderr.text).toContain(
      "a service token reads only the config it was made for, so use one made for billing/dev, or a service account token",
    );
  });

  test("a secret name Doppler can't store is refused before anything is read", async () => {
    const run = project({
      map: MAP.replace(
        '[profiles.dev]\nSTRIPE_API_KEY = { description = "Stripe" }',
        '[profiles.dev]\nSTRIPE_API_KEY = { description = "Stripe" }\nDOPPLER_CONFIG = { description = "config" }',
      ),
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      "[profiles.dev] DOPPLER_CONFIG: Doppler reserves the secret name DOPPLER_CONFIG for itself",
    );
  });

  test("status notes that Doppler keeps no rotated date, without failing", async () => {
    const map = MAP.replace(
      "[tool.keypin.prod.STRIPE_API_KEY]",
      '[tool.keypin.dev.STRIPE_API_KEY]\nrotate_every = "90d"\n\n[tool.keypin.prod.STRIPE_API_KEY]',
    );
    const run = project({ map });
    expect(await cli(["status"], run.deps)).toBe(0);
    expect(run.stdout.text).not.toMatch(/\bproblems?\b/);
    expect(run.stdout.text).toMatch(/notice/);
    expect(run.stdout.text).toContain(
      "STRIPE_API_KEY (dev): no rotated date\n    Doppler keeps no rotated date on a secret, so keypin can't tell when this key is due (docs/integrations/vaults/doppler.md).",
    );
  });

  test("rotate --check fails a key whose schedule Doppler can't date, and says the two ways out", async () => {
    const run = project({ map: ISSUER_MAP });
    expect(await cli(["rotate", "--check"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      'STRIPE_API_KEY (prod): its vault keeps no rotation date, so scheduled rotation can\'t cover it. Set rotate_every = "never" in [tool.keypin.prod.STRIPE_API_KEY], or remove it, and rotate it by hand with keypin rotate STRIPE_API_KEY --profile prod.',
    );
    expect(run.issued).toEqual([]);
  });

  test("rotate --due skips that key, and exits 0", async () => {
    const run = project({ map: ISSUER_MAP });
    expect(await cli(["rotate", "--due", "--yes"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain("STRIPE_API_KEY  skip  no rotated date in the vault");
    expect(run.issued).toEqual([]);
  });

  describe("rotate --check with keys in Doppler and in 1Password", () => {
    const PUBLISH = `publish = [{ to = "github-actions", repo = "acme/billing" }]\n`;
    const mixed = (schedules: Record<string, string>) => {
      const tool = (key: string, admin: string, publish = PUBLISH) => `
[tool.keypin.prod.${key}]
rotate_every = "${schedules[key]}"
${publish}issuer = { kind = "resend", admin = "${admin}", permission = "sending_access" }
`;
      const admin = "doppler://billing/prd/RESEND_ADMIN_KEY";
      return `[project]
name = "billing"
revision = "1.0"

[providers]
doppler_prd = "doppler://billing/prd"
op = "onepassword://my.1password.com@Private"

[defaults]
providers = ["doppler_prd"]

[profiles.prod]
STRIPE_API_KEY = { description = "Stripe" }
RESEND_ADMIN_KEY = { description = "Resend admin" }
SECOND_KEY = { description = "Another Doppler key" }
MAILER_KEY = { description = "Mailer", providers = ["op"], ref = { item = "mailer key", field = "credential" } }
${tool("STRIPE_API_KEY", admin)}${tool("SECOND_KEY", admin)}${tool("MAILER_KEY", "op://Private/resend admin key/credential", "")}`;
    };
    const doppler = () => {
      const w = world();
      const prd = w.projects.billing?.prd;
      if (prd) prd.SECOND_KEY = { value: `${SENTINEL}-second` };
      return w;
    };
    const onePassword = {
      values: { "mailer key": `${SENTINEL}-mailer`, "resend admin key": `${SENTINEL}-admin` },
      metadata: { "mailer key": { rotated: "2026-11-01" } },
    };

    test("reports every Doppler key with a schedule in one run, and checks the rest", async () => {
      const map = mixed({ STRIPE_API_KEY: "90d", SECOND_KEY: "30d", MAILER_KEY: "90d" });
      const run = project({ map, doppler: doppler(), onePassword });
      expect(await cli(["rotate", "--check"], run.deps)).toBe(1);
      for (const key of ["STRIPE_API_KEY", "SECOND_KEY"])
        expect(run.stderr.text).toContain(
          `${key} (prod): its vault keeps no rotation date, so scheduled rotation can't cover it.`,
        );
      expect(run.stderr.text).toContain("MAILER_KEY (prod) is ready for keypin rotate --due.");
    });

    test('rotate_every = "never" is the way out, and the check passes', async () => {
      const map = mixed({ STRIPE_API_KEY: "never", SECOND_KEY: "never", MAILER_KEY: "90d" });
      const run = project({ map, doppler: doppler(), onePassword });
      expect(await cli(["rotate", "--check"], run.deps), run.stderr.text).toBe(0);
      expect(run.stderr.text).toMatch(/STRIPE_API_KEY +skip +never rotates/);
      expect(run.stderr.text).not.toContain("keeps no rotation date");
    });
  });

  test("publish reads the prod value from the provider's config and writes it to GitHub", async () => {
    const run = project({ env: { DOPPLER_TOKEN: SERVICE_TOKEN } });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing",
      `write github-actions:acme/billing STRIPE_API_KEY (${SENTINEL.length + 5} chars)`,
    ]);
    expect(run.stderr.text).toContain(
      "STRIPE_API_KEY prod  from doppler://billing/prd/STRIPE_API_KEY in Doppler",
    );
  });

  test("check says to declare an env file's key and set it in Doppler, not to import it", async () => {
    const run = project();
    run.disk.contents.set("/work/billing/.env", `RESEND_KEY=${SENTINEL}\n`);
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).not.toContain("keypin import");
    expect(run.stdout.text).toContain(
      "declare the secrets in secretspec.toml, then save each value in Doppler with secretspec set (docs/integrations/vaults/doppler.md)",
    );
  });

  test("rotate saves the new key in Doppler with a read/write service token", async () => {
    const run = project({ map: ISSUER_MAP, env: { DOPPLER_TOKEN: SERVICE_TOKEN } });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.store.effects).toEqual(["doppler update billing/prd/STRIPE_API_KEY"]);
    expect(run.store.load()[0]?.secret).toEqual({ value: ISSUED });
    expect(run.stderr.text).toContain(
      "Doppler  doppler://billing/prd/STRIPE_API_KEY  saved, rotated 2026-11-09",
    );
    expect(run.stderr.text + run.stdout.text).not.toContain(ISSUED);
    expect(run.onePassword.calls).toEqual([]);
  });

  test("rotate with a read-only service token revokes the new key, and nothing changes", async () => {
    const doppler = world({
      [SERVICE_TOKEN]: { type: "service_token", project: "billing", config: "prd", access: "read" },
    });
    const run = project({ map: ISSUER_MAP, env: { DOPPLER_TOKEN: SERVICE_TOKEN }, doppler });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text + run.stdout.text).toContain(
      "keypin needs a service token with write access to billing/prd, so make a service token with read/write access",
    );
    expect(run.issued).toEqual([expect.stringMatching(/^create /), "revoke key-1"]);
    expect(run.store.effects).toEqual([]);
    expect(run.destinations.log).toEqual(["check github-actions:acme/billing"]);
  });

  test("rotate stops before creating a key when the secret references another", async () => {
    const doppler = world();
    const prd = doppler.projects.billing?.prd;
    if (prd) prd.STRIPE_API_KEY = { value: "${shared.prd.STRIPE_API_KEY}" };
    doppler.projects.shared = { prd: { STRIPE_API_KEY: { value: `${SENTINEL}-shared` } } };
    const run = project({ map: ISSUER_MAP, doppler });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text + run.stdout.text).toContain(
      "point secretspec.toml at doppler://shared/prd/STRIPE_API_KEY instead",
    );
    expect(run.issued).toEqual([]);
    expect(run.store.effects).toEqual([]);
  });

  test("rotate stops before creating a key when the secret is inherited from another config", async () => {
    const doppler: FakeDoppler = {
      ...world(),
      projects: {
        billing: {
          dev: { STRIPE_API_KEY: { value: SENTINEL } },
          prd: { RESEND_ADMIN_KEY: { value: `${SENTINEL}-admin` } },
        },
        shared: { prd: { STRIPE_API_KEY: { value: `${SENTINEL}-shared` } } },
      },
      inherits: { "billing/prd": [{ project: "shared", config: "prd" }] },
    };
    const run = project({ map: ISSUER_MAP, doppler });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text + run.stdout.text).toContain(
      "billing/prd inherits doppler://shared/prd/STRIPE_API_KEY, and Doppler doesn't say whether the secret here overrides it",
    );
    expect(run.issued).toEqual([]);
    expect(run.store.effects).toEqual([]);
  });

  test("rotate saves a ref's secret in the config the ref names", async () => {
    const doppler: FakeDoppler = {
      ...world(),
      projects: {
        billing: {
          dev: { STRIPE_API_KEY: { value: SENTINEL } },
          prd: { RESEND_ADMIN_KEY: { value: `${SENTINEL}-admin` } },
          prd_aws: { STRIPE_API_KEY: { value: `${SENTINEL}-aws` } },
        },
      },
    };
    const map = ISSUER_MAP.replace(
      '[profiles.prod]\nSTRIPE_API_KEY = { description = "Stripe" }',
      '[profiles.prod]\nSTRIPE_API_KEY = { description = "Stripe", ref = { item = "prd_aws/STRIPE_API_KEY" } }',
    );
    const run = project({ map, doppler });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.store.effects).toEqual(["doppler update billing/prd_aws/STRIPE_API_KEY"]);
    expect(run.store.load()[0]?.secret).toEqual({ value: ISSUED });
    expect(run.issued).toEqual([expect.stringMatching(/^create /)]);
  });
});

describe("keypin with Doppler, signed in with GitHub Actions OIDC", () => {
  const IDENTITY = "8c2d4e6f-0000-4000-8000-000000000002";
  const JWT = "github-jwt-sentinel-6a2e";
  const OIDC = {
    DOPPLER_TOKEN: "",
    KEYPIN_DOPPLER_IDENTITY_ID: IDENTITY,
    KEYPIN_DOPPLER_AUDIENCE: "https://github.com/acme",
  };
  const fresh = (): FakeDoppler => ({ ...world(), oidc: { identityId: IDENTITY, jwt: JWT } });
  const idToken: IdToken = async () => JWT;

  test("check says how it signed in, and gives the fix without a job token", async () => {
    const signed = project({ env: OIDC, doppler: fresh(), idToken });
    expect(await cli(["check"], signed.deps)).toBe(0);
    expect(signed.events.at(-1)).toBe("POST /v3/auth/revoke");
    expect(signed.stdout.text).toContain(
      "Note: keypin signs in to Doppler with GitHub Actions OIDC, as the service account identity in KEYPIN_DOPPLER_IDENTITY_ID\n",
    );
    const unsigned = project({ env: OIDC, doppler: fresh() });
    expect(await cli(["check"], unsigned.deps)).toBe(1);
    expect(unsigned.stdout.text).toContain(
      "Give the GitHub Actions job permissions: id-token: write, or unset KEYPIN_DOPPLER_IDENTITY_ID",
    );
  });
});
