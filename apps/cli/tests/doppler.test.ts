import { describe, expect, test } from "vite-plus/test";
import { type Issuer, Secret } from "@keypin/core";
import { dopplerBackend, tokenFrom } from "@keypin/connectors/doppler";
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
  fakeLauncher,
  fakeVault,
  memoryFiles,
  parseJson,
  REGISTRY,
  registryWith,
  SENTINEL,
} from "./fakes";

const SERVICE_TOKEN = "dp.st.prd.sentinel-token-7c2e";
const ACCOUNT_TOKEN = "dp.sa.sentinel-account-4f1b";
const ISSUED = "re_issued_sentinel_value_8d3a";

const MAP = `
[doppler]
workplace = "acme"

[keys.STRIPE_API_KEY]
rotate_every = "90d"
dev = "doppler://billing/dev/STRIPE_API_KEY"

[keys.STRIPE_API_KEY.prod]
from = "doppler://billing/prd/STRIPE_API_KEY"
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

const ISSUER_MAP = `${MAP}
[keys.STRIPE_API_KEY.prod.issuer]
kind = "resend"
admin = "doppler://billing/prd/RESEND_ADMIN_KEY"
permission = "sending_access"
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
  options: { env?: Record<string, string>; map?: string; doppler?: FakeDoppler } = {},
) {
  const disk = memoryFiles({
    "/work/billing/keypin.toml": options.map ?? MAP,
    [REGISTRY]: registryWith("/work/billing"),
  });
  const store = memoryStore();
  const env = { PATH: "/usr/bin", DOPPLER_TOKEN: ACCOUNT_TOKEN, ...options.env };
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
  const doppler = dopplerBackend(tokenFrom(env), dopplerFetch(options.doppler ?? world(), store));
  const launcher = fakeLauncher();
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

describe("keypin with Doppler", () => {
  test("run gives the command the dev value, never DOPPLER_TOKEN", async () => {
    const run = project();
    expect(await cli(["run", "--", "env"], run.deps)).toBe(0);
    expect(run.launcher.launches[0]?.env).toEqual({ PATH: "/usr/bin", STRIPE_API_KEY: SENTINEL });
    expect(run.stderr.text).toContain(
      "Read 1 dev value from Doppler workplace acme  doppler://billing/dev/STRIPE_API_KEY",
    );
    expect(run.onePassword.calls).toEqual([]);
  });

  test("run without DOPPLER_TOKEN says what to set, and starts nothing", async () => {
    const run = project({ env: { DOPPLER_TOKEN: "" } });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "Doppler workplace acme: sign-in failed: set DOPPLER_TOKEN to a Doppler service token, service account token or personal token",
    );
    expect(run.launcher.launches).toEqual([]);
  });

  test("a service token for prd can't read dev, and says why", async () => {
    const run = project({ env: { DOPPLER_TOKEN: SERVICE_TOKEN } });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "a service token reads only the config it was made for, so use one made for billing/dev, or a service account token",
    );
  });

  test("check names the token kind, never the token, and looks up without reading values", async () => {
    const run = project();
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).toContain(
      "Note: keypin signs in to Doppler with the service account token in DOPPLER_TOKEN\n",
    );
    expect(run.stderr.text).toContain(
      "Looked up 2 items in Doppler workplace acme, not the values",
    );
    expect(run.stdout.text + run.stderr.text).not.toContain(ACCOUNT_TOKEN);
    expect(run.stdout.text + run.stderr.text).not.toContain(SENTINEL);
  });

  test("a token from another workplace is one sign-in step", async () => {
    const run = project({ doppler: { ...world(), workplace: "globex" } });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text.split("Sign in to Doppler")).toHaveLength(2);
    expect(run.stdout.text).toContain(
      "Use a token from the workplace keypin.toml pins under [doppler].",
    );
    const json = project({ doppler: { ...world(), workplace: "globex" } });
    expect(await cli(["check", "--json"], json.deps)).toBe(1);
    expect(parseJson(json.stdout.text)).toMatchObject({
      onePassword: null,
      prerequisites: [{ name: "Doppler", status: "sign-in failed" }],
    });
  });

  test("a key named DOPPLER_TOKEN is refused", async () => {
    const map = `${MAP}\n[keys.DOPPLER_TOKEN]\nrotate_every = "never"\ndev = "doppler://billing/dev/STRIPE_API_KEY"\n`;
    const run = project({ map });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "keypin.toml maps DOPPLER_TOKEN, which keypin uses to sign in",
    );
  });

  test("status notes that Doppler keeps no rotated date, without failing", async () => {
    const run = project();
    expect(await cli(["status"], run.deps)).toBe(0);
    expect(run.stdout.text).not.toMatch(/\bproblems?\b/);
    expect(run.stdout.text).toMatch(/notice/);
    expect(run.stdout.text).toContain(
      "STRIPE_API_KEY (dev): no rotated date\n    Doppler keeps no rotated date on a secret, so keypin can't tell when this key is due (docs/doppler.md).",
    );
  });

  test("publish reads the prod value from Doppler and writes it to GitHub", async () => {
    const run = project({ env: { DOPPLER_TOKEN: SERVICE_TOKEN } });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing",
      `write github-actions:acme/billing STRIPE_API_KEY (${SENTINEL.length + 5} chars)`,
    ]);
    expect(run.stderr.text).toContain(
      "STRIPE_API_KEY prod  from doppler://billing/prd/STRIPE_API_KEY in Doppler workplace acme",
    );
  });

  test("check says to add an env file's key in Doppler, not to import it", async () => {
    const run = project({ map: MAP.replace('dev = "doppler://billing/dev/STRIPE_API_KEY"\n', "") });
    run.disk.contents.set("/work/billing/.env", `STRIPE_API_KEY=${SENTINEL}\n`);
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).not.toContain("keypin import");
    expect(run.stdout.text).toContain(
      "add the secrets in Doppler and map them with doppler:// references (docs/doppler.md)",
    );
  });

  test("import says it creates 1Password items when the map reads from Doppler", async () => {
    const run = project();
    run.disk.contents.set("/work/billing/.env", "RESEND_KEY=resend-value-1234\n");
    expect(await cli(["import", ".env", "--vault", "Private", "--yes"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "import creates 1Password items, and /work/billing/keypin.toml reads from Doppler; add the secrets in Doppler and map them with doppler:// references (docs/doppler.md)",
    );
    expect(run.store.effects).toEqual([]);
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
      "point keypin.toml at doppler://shared/prd/STRIPE_API_KEY instead",
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
    expect(run.stderr.text + run.stdout.text).toContain(
      "point keypin.toml at doppler://shared/prd/STRIPE_API_KEY instead",
    );
    expect(run.issued).toEqual([]);
    expect(run.store.effects).toEqual([]);
  });

  test("rotate saves a branch config's own secret when its root has none of that name", async () => {
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
      'from = "doppler://billing/prd/STRIPE_API_KEY"',
      'from = "doppler://billing/prd_aws/STRIPE_API_KEY"',
    );
    const run = project({ map, doppler });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.store.effects).toEqual(["doppler update billing/prd_aws/STRIPE_API_KEY"]);
    expect(run.store.load()[0]?.secret).toEqual({ value: ISSUED });
    expect(run.issued).toEqual([expect.stringMatching(/^create /)]);
  });
});
