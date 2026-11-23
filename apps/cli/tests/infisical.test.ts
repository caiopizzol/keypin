import { describe, expect, test } from "vite-plus/test";
import { generationOf, type IdToken, type Issuer, loadState, Secret } from "@keypin/core";
import { credentialsFrom, infisicalBackend } from "@keypin/connectors/infisical";
import {
  type FakeInfisical,
  infisicalFetch,
  memoryStore,
  mergeHeld,
} from "@keypin/connectors/infisical/testing";
import { cli } from "../src/cli";
import { vaults } from "../src/start";
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
  STATE,
} from "./fakes";

const CREDENTIALS = {
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "client-id-1",
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "client-secret-sentinel-9c1d",
};

const ID = "7e2f1a4c-0b1d-4c8e-9f00-1234567890ab";
const WHERE = "Infisical at https://app.infisical.com";
const PROD = `infisical://${ID}/prod/STRIPE_API_KEY`;

const MAP = `[project]
name = "billing"
revision = "1.0"

[providers]
infisical = "infisical://app.infisical.com/${ID}"

[defaults]
providers = ["infisical"]

[profiles.dev]
STRIPE_API_KEY = { description = "Stripe" }

[profiles.prod]
STRIPE_API_KEY = { description = "Stripe", ref = { item = "/STRIPE_API_KEY" } }

[tool.keypin.dev.STRIPE_API_KEY]
rotate_every = "90d"

[tool.keypin.prod.STRIPE_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

const ISSUER_MAP = `${MAP}issuer = { kind = "resend", admin = "infisical://${ID}/prod/RESEND_ADMIN_KEY", permission = "sending_access" }
`;

const ISSUED = "re_issued_sentinel_value_2c8f";

const INFISICAL: FakeInfisical = {
  projectIds: { billing: ID },
  projects: {
    billing: {
      dev: {
        "/secretspec/billing/dev/STRIPE_API_KEY": { value: SENTINEL, rotated: "2026-10-01" },
      },
      prod: {
        STRIPE_API_KEY: { value: `${SENTINEL}-prod`, rotated: "2026-08-01" },
        RESEND_ADMIN_KEY: { value: `${SENTINEL}-admin` },
      },
    },
  },
};

interface Earlier {
  disk: ReturnType<typeof memoryFiles>;
  store: ReturnType<typeof memoryStore>;
  keys: Set<string>;
}

function project(
  options: {
    env?: Record<string, string>;
    map?: string;
    infisical?: FakeInfisical;
    after?: Earlier;
    idToken?: IdToken;
  } = {},
) {
  const disk =
    options.after?.disk ??
    memoryFiles({
      "/work/billing/secretspec.toml": options.map ?? MAP,
      [REGISTRY]: registryWith("/work/billing"),
    });
  const store = options.after?.store ?? memoryStore();
  const env = { PATH: "/usr/bin", ...CREDENTIALS, ...options.env };
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
  const events: string[] = [];
  const served = infisicalFetch(options.infisical ?? INFISICAL, store);
  const infisical = infisicalBackend(
    credentialsFrom(env),
    (url, init) => {
      events.push(`${init.method} ${new URL(url).pathname}`);
      return served(url, init);
    },
    options.idToken ? { idToken: options.idToken } : {},
  );
  const destinations = fakeDestinations();
  const issued: string[] = [];
  const keys = options.after?.keys ?? new Set<string>();
  const issuer: Issuer = {
    describe: () => "Resend",
    dashboard: () => "https://resend.com/api-keys",
    checkAccount: async (id) => {
      const facts = `the admin key lists ${keys.size} API keys`;
      return id === null || keys.has(id)
        ? { ok: true, facts }
        : { ok: false, facts, reason: `Resend doesn't list key ${id}` };
    },
    async create(name) {
      issued.push(`create ${name}`);
      const count = keys.size + 1;
      keys.add(`key-${count}`);
      return {
        id: `key-${count}`,
        secret: new Secret(count === 1 ? ISSUED : `${ISSUED}-${count}`),
      };
    },
    async revoke(id) {
      issued.push(`revoke ${id}`);
      keys.delete(id);
      return "revoked";
    },
  };
  const fake = fakeDeps({
    disk,
    backend: routedVault({
      "1password": () => (signIn(), onePassword.vault),
      infisical: () => infisical,
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
  return { ...fake, destinations, store, onePassword, issued, keys, events };
}

describe("keypin with Infisical", () => {
  test("check without credentials names the variables as the sign-in step", async () => {
    const run = project({ env: { INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "" } });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text.split("Sign in to Infisical")).toHaveLength(2);
    expect(run.stdout.text).toContain(
      "Set INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    );
    expect(run.events).toEqual([]);
  });

  test("check looks the secrets up in the project the provider names, for any organization", async () => {
    const run = project();
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain(`Looked up 2 items in ${WHERE}, not the values`);
    expect(run.events).toEqual([
      "POST /api/v1/auth/universal-auth/login",
      "GET /api/v4/secrets/STRIPE_API_KEY",
      "GET /api/v4/secrets/STRIPE_API_KEY",
    ]);
    expect(run.stdout.text).not.toContain("1Password");
  });

  describe("signed in with GitHub Actions OIDC", () => {
    const IDENTITY = "4f1a9b2c-0000-4000-8000-000000000001";
    const JWT = "github-jwt-sentinel-3f7c";
    const OIDC = {
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "",
      KEYPIN_INFISICAL_IDENTITY_ID: IDENTITY,
      KEYPIN_INFISICAL_AUDIENCE: "https://github.com/acme",
    };
    const fresh = (): FakeInfisical => ({ ...INFISICAL, oidc: { identityId: IDENTITY, jwt: JWT } });
    const idToken: IdToken = async () => JWT;

    test("check revokes the token before it exits, and says how it signed in", async () => {
      const run = project({ env: OIDC, infisical: fresh(), idToken });
      expect(await cli(["check"], run.deps)).toBe(0);
      expect(run.events.at(-1)).toBe("POST /api/v1/auth/token/revoke");
      expect(run.stdout.text).toContain(
        "Note: keypin signs in to Infisical with GitHub Actions OIDC, as the machine identity in KEYPIN_INFISICAL_IDENTITY_ID\n",
      );
    });

    test("check without a job token gives the fix as the sign-in step", async () => {
      const run = project({ env: OIDC, infisical: fresh() });
      expect(await cli(["check"], run.deps)).toBe(1);
      expect(run.stdout.text).toContain(
        "Give the GitHub Actions job permissions: id-token: write, or unset KEYPIN_INFISICAL_IDENTITY_ID",
      );
    });
  });

  describe("signed in with an access token", () => {
    const TOKEN = "access-token-sentinel-6f2a";
    const NO_CLIENT = {
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "",
    };

    test("check says which sign-in it used", async () => {
      const token = project({
        env: { ...NO_CLIENT, INFISICAL_TOKEN: TOKEN },
        infisical: { ...INFISICAL, accessToken: TOKEN },
      });
      expect(await cli(["check"], token.deps)).toBe(0);
      expect(token.stdout.text).toContain(
        "Note: keypin signs in to Infisical with the access token in INFISICAL_TOKEN\n",
      );
      const both = project({ env: { INFISICAL_TOKEN: TOKEN } });
      expect(await cli(["check"], both.deps)).toBe(0);
      expect(both.stdout.text).toContain(
        "Note: keypin signs in to Infisical with the Universal Auth client ID and secret, not INFISICAL_TOKEN\n",
      );
      expect(token.stdout.text + both.stdout.text).not.toContain(TOKEN);
    });

    test("a user's token is one sign-in step asking for a machine identity's", async () => {
      const run = project({
        env: { ...NO_CLIENT, INFISICAL_TOKEN: TOKEN },
        infisical: { ...INFISICAL, userToken: TOKEN },
      });
      expect(await cli(["check"], run.deps)).toBe(1);
      expect(run.stdout.text).toContain(
        "the access token in INFISICAL_TOKEN isn't a machine identity's; use a machine identity's access token",
      );
      expect(run.stdout.text.split("Sign in to Infisical")).toHaveLength(2);
      expect(run.stdout.text).toContain(
        "Check INFISICAL_TOKEN and the host in your infisical:// provider in secretspec.toml",
      );
    });
  });

  describe("a rate limit or old server while signing in is the Infisical sign-in step in check", () => {
    const TOKEN = "access-token-sentinel-9d1e";
    const cases: [string, Record<string, string>, Partial<FakeInfisical>, string][] = [
      [
        "a rate-limited login",
        {},
        { rateLimited: { times: 1 } },
        "Infisical is limiting how often",
      ],
      [
        "a rate-limited token check",
        { INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "", INFISICAL_TOKEN: TOKEN },
        { accessToken: TOKEN, rateLimited: { times: 1 } },
        "Infisical is limiting how often",
      ],
      [
        "a server without the token check",
        { INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "", INFISICAL_TOKEN: TOKEN },
        { accessToken: TOKEN, missingRoutes: ["/api/v1/identities/details"] },
        "the server has no GET /api/v1/identities/details",
      ],
    ];
    test.each(cases)("%s", async (_, env, infisical, said) => {
      const fresh = () => ({ ...INFISICAL, ...structuredClone(infisical) });
      const run = project({ env, infisical: fresh() });
      expect(await cli(["check"], run.deps)).toBe(1);
      expect(run.stdout.text.split("Sign in to Infisical")).toHaveLength(2);
      expect(run.stdout.text).toContain(`sign-in failed: ${said}`);
      expect(run.stdout.text).not.toContain("Fix the vault item");
      const json = project({ env, infisical: fresh() });
      expect(await cli(["check", "--json"], json.deps)).toBe(1);
      expect(parseJson(json.stdout.text)).toMatchObject({
        prerequisites: [{ name: "Infisical", status: "sign-in failed" }],
      });
    });
  });

  test("status reads the rotated date from each profile's secret metadata", async () => {
    const run = project();
    expect(await cli(["status", "--json"], run.deps)).toBe(1);
    expect(parseJson(run.stdout.text)).toMatchObject({
      rows: [
        { keyId: "STRIPE_API_KEY", environment: "dev", rotated: "2026-10-01", due: "2026-12-30" },
        { keyId: "STRIPE_API_KEY", environment: "prod", rotated: "2026-08-01", due: "2026-10-30" },
      ],
    });
    expect(run.stderr.text).toContain(`Read 2 rotated dates from ${WHERE}, not the values`);
  });

  test("status tells how to set the rotated metadata when it's missing", async () => {
    const run = project({
      infisical: {
        ...INFISICAL,
        projects: {
          billing: {
            ...INFISICAL.projects.billing,
            dev: { "/secretspec/billing/dev/STRIPE_API_KEY": { value: SENTINEL } },
          },
        },
      },
    });
    await cli(["status"], run.deps);
    expect(run.stdout.text).toContain(
      "Add rotated to the Infisical secret's metadata, with the day the value last changed as YYYY-MM-DD.",
    );
  });

  test("publish reads the prod value from the ref's secret and writes it to GitHub", async () => {
    const run = project();
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing",
      `write github-actions:acme/billing STRIPE_API_KEY (${SENTINEL.length + 5} chars)`,
    ]);
    expect(run.stderr.text).toContain(`STRIPE_API_KEY prod  from ${PROD} in ${WHERE}`);
    expect(run.stderr.text).not.toContain(SENTINEL);
  });

  test("publish --profile dev reads secretspec's own secret for the dev profile", async () => {
    const map = MAP.replace(
      "[tool.keypin.dev.STRIPE_API_KEY]\n",
      '[tool.keypin.dev.STRIPE_API_KEY]\npublish = [{ to = "github-actions", repo = "acme/billing-dev" }]\n',
    );
    const run = project({ map });
    expect(await cli(["publish", "STRIPE_API_KEY", "--profile", "dev"], run.deps)).toBe(0);
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing-dev",
      `write github-actions:acme/billing-dev STRIPE_API_KEY (${SENTINEL.length} chars)`,
    ]);
    expect(run.stderr.text).toContain(
      `from infisical://${ID}/dev/secretspec/billing/dev/STRIPE_API_KEY in ${WHERE}`,
    );
  });

  test.each([["check"], ["status"], ["publish", "STRIPE_API_KEY"]])(
    "%s never needs 1Password when every key is in Infisical",
    async (...command) => {
      const run = project({ env: { KEYPIN_1PASSWORD: "service-account" } });
      const code = await cli(command, run.deps);
      expect(run.stderr.text + run.stdout.text).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
      expect(code).toBe(command[0] === "status" ? 1 : 0);
      if (command[0] === "status") expect(run.stdout.text).toContain("STRIPE_API_KEY");
      if (command[0] === "publish") expect(run.destinations.log).toHaveLength(2);
    },
  );

  test("check --json reports no 1Password sign-in when every key is in Infisical", async () => {
    const run = project({ env: { KEYPIN_1PASSWORD: "service-account" } });
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    expect(parseJson(run.stdout.text)).toMatchObject({ onePassword: null });
  });

  test("a 1Password key in the same file still needs the service account's token", async () => {
    const map = MAP.replace(
      "\n[tool.keypin.dev.STRIPE_API_KEY]",
      `RESEND_KEY = { description = "Resend", providers = ["onepassword://my.1password.com@Private"] }\n\n[tool.keypin.dev.STRIPE_API_KEY]`,
    );
    for (const command of [["check"], ["status"]]) {
      const run = project({ map, env: { KEYPIN_1PASSWORD: "service-account" } });
      expect(await cli(command, run.deps)).toBe(1);
      expect(run.stderr.text + run.stdout.text).toContain(
        "KEYPIN_1PASSWORD=service-account needs the service account's token in OP_SERVICE_ACCOUNT_TOKEN",
      );
    }
  });

  test("check says to declare an env file's key and set it in Infisical, not to import it", async () => {
    const run = project();
    run.disk.contents.set("/work/billing/.env", `RESEND_KEY=${SENTINEL}\n`);
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).not.toContain("keypin import");
    expect(run.stdout.text).toContain(
      "declare the secrets in secretspec.toml, then save each value in Infisical with secretspec set (docs/integrations/vaults/infisical.md)",
    );
  });

  test("status names rotate for an Infisical key with an issuer, even with a 1Password service account set", async () => {
    const run = project({ map: ISSUER_MAP, env: { KEYPIN_1PASSWORD: "service-account" } });
    expect(await cli(["status"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain("    Run keypin rotate STRIPE_API_KEY in /work/billing.\n");
    expect(run.stderr.text + run.stdout.text).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(run.onePassword.calls).toEqual([]);
  });

  test("rotate saves the new key to the Infisical secret and never signs in to 1Password", async () => {
    const run = project({ map: ISSUER_MAP, env: { KEYPIN_1PASSWORD: "service-account" } });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.issued).toEqual(["create STRIPE_API_KEY prod 2026-11-09 12:00:00 a1b2c3"]);
    expect(run.store.effects).toEqual(["infisical update billing/prod/STRIPE_API_KEY"]);
    expect(run.store.load()[0]?.secret).toEqual({ value: ISSUED, rotated: "2026-11-09" });
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing",
      `write github-actions:acme/billing STRIPE_API_KEY (${ISSUED.length} chars)`,
    ]);
    expect(run.stderr.text).toContain(`STRIPE_API_KEY prod  from ${PROD} in ${WHERE}`);
    expect(run.stderr.text).toContain(`Infisical  ${PROD}  saved, rotated 2026-11-09`);
    expect(run.stderr.text + run.stdout.text).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(run.stderr.text + run.stdout.text).not.toContain(ISSUED);
    expect(run.onePassword.calls).toEqual([]);
    const state = await loadState(run.disk.files, STATE, vaults);
    expect(state.receipts.map((r) => r.generation)).toEqual([
      await generationOf(new Secret(ISSUED)),
    ]);
  });

  describe("an Infisical change policy holds the save for approval", () => {
    const policy = (): FakeInfisical => structuredClone(INFISICAL);
    const SECOND = `${ISSUED}-2`;

    async function heldRotation() {
      const infisical = policy();
      const first = project({ map: ISSUER_MAP, infisical });
      expect(await cli(["rotate", "STRIPE_API_KEY"], first.deps)).toBe(0);
      infisical.heldByPolicy = [];
      const held = project({ map: ISSUER_MAP, infisical, after: first });
      const code = await cli(["rotate", "STRIPE_API_KEY"], held.deps);
      return { infisical, first, held, code };
    }

    test("keeps the new key, doesn't say to delete it, and exits 3", async () => {
      const { infisical, held, code } = await heldRotation();
      expect(code).toBe(3);
      expect(held.issued).toEqual(["create STRIPE_API_KEY prod 2026-11-09 12:00:00 a1b2c3"]);
      expect(held.store.effects.at(-1)).toBe("infisical hold update billing/prod/STRIPE_API_KEY");
      expect(infisical.heldByPolicy?.[0]?.secret.value).toBe(SECOND);
      expect(held.stderr.text).toContain("Infisical holds the change for approval");
      expect(held.stderr.text).toContain(
        "The new key key-2 at Resend stays valid: the change holds it.",
      );
      expect(held.stderr.text).toContain(
        "If the change is rejected or cancelled, delete key key-2 at https://resend.com/api-keys, then run this again.",
      );
      expect(held.destinations.log).toEqual(["check github-actions:acme/billing"]);
      const state = await loadState(held.disk.files, STATE, vaults);
      expect(state.issued).toMatchObject([
        { id: "key-2", generation: await generationOf(new Secret(SECOND)), held: true },
      ]);
      expect(held.keys.has("key-2")).toBe(true);
    });

    test("a save with an unknown outcome keeps the pending mark, so the rerun waits instead of making another key", async () => {
      const infisical = policy();
      const first = project({ map: ISSUER_MAP, infisical });
      expect(await cli(["rotate", "STRIPE_API_KEY"], first.deps)).toBe(0);
      infisical.failWrites = true;
      const failed = project({ map: ISSUER_MAP, infisical, after: first });
      expect(await cli(["rotate", "STRIPE_API_KEY"], failed.deps)).toBe(1);
      expect(failed.stderr.text).toContain(
        "Stopped: keypin can't tell whether Infisical saved the new key key-2.",
      );
      infisical.failWrites = false;
      const waiting = project({ map: ISSUER_MAP, infisical, after: failed });
      expect(await cli(["rotate", "STRIPE_API_KEY"], waiting.deps)).toBe(3);
      expect(waiting.issued).toEqual([]);
    });

    test("a rerun before the change is merged waits and creates no key", async () => {
      const { infisical, held } = await heldRotation();
      const waiting = project({ map: ISSUER_MAP, infisical, after: held });
      expect(await cli(["rotate", "STRIPE_API_KEY"], waiting.deps)).toBe(3);
      expect(waiting.issued).toEqual([]);
      expect(waiting.destinations.log).toEqual([]);
      expect(waiting.stderr.text).toContain(
        "Stopped: Infisical still holds the change that saves key key-2 for approval. Nothing was created.",
      );
    });

    test("a rerun after the change is merged publishes and revokes, with no second key", async () => {
      const { infisical, held } = await heldRotation();
      mergeHeld(infisical, held.store);
      const resumed = project({ map: ISSUER_MAP, infisical, after: held });
      expect(await cli(["rotate", "STRIPE_API_KEY"], resumed.deps)).toBe(0);
      expect(resumed.stderr.text).toContain("Resuming: keypin created key key-2 at Resend");
      expect(resumed.issued).toEqual(["revoke key-1"]);
      expect(resumed.destinations.log).toEqual([
        "check github-actions:acme/billing",
        `write github-actions:acme/billing STRIPE_API_KEY (${SECOND.length} chars)`,
      ]);
    });
  });

  describe("a secret that comes from another Infisical secret", () => {
    const shared = (): FakeInfisical => {
      const { STRIPE_API_KEY, ...prod } = structuredClone(INFISICAL.projects.billing?.prod ?? {});
      return {
        projectIds: { billing: ID },
        projects: {
          billing: { prod, shared: { STRIPE_API_KEY: STRIPE_API_KEY ?? { value: "" } } },
        },
        imports: [{ into: "prod", environment: "shared" }],
      };
    };
    const referenced = (): FakeInfisical => {
      const infisical = structuredClone(INFISICAL);
      const prod = infisical.projects.billing?.prod ?? {};
      infisical.projects.billing = {
        ...infisical.projects.billing,
        shared: { "/stripe/STRIPE_API_KEY": { value: `${SENTINEL}-shared` } },
        prod: { ...prod, STRIPE_API_KEY: { value: "${shared.stripe.STRIPE_API_KEY}" } },
      };
      return infisical;
    };

    test.each([
      [
        "imported from another environment",
        shared,
        `${SENTINEL}-prod`,
        `the secret is imported from infisical://${ID}/shared/STRIPE_API_KEY`,
      ],
      [
        "that references another",
        referenced,
        `${SENTINEL}-shared`,
        `the secret references infisical://${ID}/shared/stripe/STRIPE_API_KEY`,
      ],
    ])("rotate refuses a secret %s, before creating anything", async (_, make, value, how) => {
      const infisical = make();
      const run = project({ map: ISSUER_MAP, infisical });
      expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(1);
      expect(run.stderr.text).toContain(how);
      expect(run.stderr.text).toContain("Nothing was created.");
      expect(run.issued).toEqual([]);
      expect(run.store.effects).toEqual([]);
      expect(run.destinations.log).toEqual([]);

      const read = project({ map: ISSUER_MAP, infisical, after: run });
      expect(await cli(["publish", "STRIPE_API_KEY"], read.deps)).toBe(0);
      expect(read.destinations.log).toEqual([
        "check github-actions:acme/billing",
        `write github-actions:acme/billing STRIPE_API_KEY (${value.length} chars)`,
      ]);
    });
  });
});
