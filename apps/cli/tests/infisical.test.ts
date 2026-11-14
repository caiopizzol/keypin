import { describe, expect, test } from "vite-plus/test";
import { generationOf, type Issuer, loadState, Secret } from "@keypin/core";
import { credentialsFrom, infisicalBackend } from "@keypin/vault-infisical";
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
  STATE,
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

const ISSUER_MAP = `${MAP}
[keys.STRIPE_API_KEY.prod.issuer]
kind = "resend"
admin = "infisical://billing/prod/RESEND_ADMIN_KEY"
permission = "sending_access"
`.replace(
  /prod = \{ from = "(.+?)", publish = \[\n(.+)\n\] \}\n/,
  '[keys.STRIPE_API_KEY.prod]\nfrom = "$1"\npublish = [$2]\n',
);

const ISSUED = "re_issued_sentinel_value_2c8f";

const INFISICAL: FakeInfisical = {
  organization: "acme",
  projects: {
    billing: {
      dev: { STRIPE_API_KEY: { value: SENTINEL, rotated: "2026-10-01" } },
      prod: {
        STRIPE_API_KEY: { value: `${SENTINEL}-prod`, rotated: "2026-08-01" },
        RESEND_ADMIN_KEY: { value: `${SENTINEL}-admin` },
      },
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
  const signIn = () =>
    onePasswordFrom(env, {
      desktop: async () => {
        throw new Error("this test opens no 1Password desktop app");
      },
      token: async () => {
        throw new Error("this test signs in with no service account");
      },
    });
  const infisical = infisicalBackend(
    credentialsFrom(env),
    infisicalFetch(options.infisical ?? INFISICAL, store),
  );
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
      infisical: () => infisical,
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

  test("run reads the secret in the folder the reference names, not one at the root", async () => {
    const run = project({
      map: `[infisical]\norganization = "acme"\n[keys.STRIPE_API_KEY]\ndev = "infisical://billing/dev/payments/STRIPE_API_KEY"\n`,
      infisical: {
        ...INFISICAL,
        projects: {
          billing: {
            dev: {
              STRIPE_API_KEY: { value: `${SENTINEL}-root` },
              "/payments/STRIPE_API_KEY": { value: `${SENTINEL}-payments` },
            },
          },
        },
      },
    });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(0);
    expect(run.launcher.launches[0]?.env.STRIPE_API_KEY).toBe(`${SENTINEL}-payments`);
  });

  test("a client ID without its secret is no credentials", async () => {
    const run = project({ env: { INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "" } });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.launcher.launches).toEqual([]);
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
    expect(other.stdout.text.split("Sign in to Infisical")).toHaveLength(2);
    expect(other.stdout.text).toContain(
      "Use a machine identity from the organization keypin.toml pins under [infisical].",
    );
    expect(other.stdout.text).not.toContain("1Password");
  });

  test.each([["run", "--", "env"], ["check"], ["status"], ["publish", "STRIPE_API_KEY"]])(
    "%s never needs 1Password when every key is in Infisical",
    async (...command) => {
      const run = project({ env: { KEYPIN_1PASSWORD: "service-account" } });
      const code = await cli(command, run.deps);
      expect(run.stderr.text + run.stdout.text).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
      expect(code).toBe(command[0] === "status" ? 1 : 0);
      if (command[0] === "run") expect(run.launcher.launches[0]?.env.STRIPE_API_KEY).toBe(SENTINEL);
      if (command[0] === "status") expect(run.stdout.text).toContain("STRIPE_API_KEY");
      if (command[0] === "publish") expect(run.destinations.log).toHaveLength(2);
    },
  );

  test("check --json reports no 1Password sign-in when every key is in Infisical", async () => {
    const run = project({ env: { KEYPIN_1PASSWORD: "service-account" } });
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    expect(parseJson(run.stdout.text)).toMatchObject({ onePassword: null });
  });

  test("a 1Password key in the same map still needs the service account's token", async () => {
    const map = `[1password]\naccount = "my.1password.com"\n${MAP}\n[keys.RESEND_KEY]\nrotate_every = "90d"\ndev = "op://Private/resend/password"\n`;
    for (const command of [["run", "--", "env"], ["check"], ["status"]]) {
      const run = project({ map, env: { KEYPIN_1PASSWORD: "service-account" } });
      expect(await cli(command, run.deps)).toBe(1);
      expect(run.stderr.text + run.stdout.text).toContain(
        "KEYPIN_1PASSWORD=service-account needs the service account's token in OP_SERVICE_ACCOUNT_TOKEN",
      );
    }
  });

  test("check says to add an env file's key in Infisical, not to import it", async () => {
    const map = MAP.replace('dev = "infisical://billing/dev/STRIPE_API_KEY"\n', "");
    const run = project({ map });
    run.disk.contents.set(
      "/work/billing/.env",
      `STRIPE_API_KEY=${SENTINEL}\nRESEND_KEY=${SENTINEL}\n`,
    );
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).not.toContain("keypin import");
    expect(run.stdout.text).toContain(
      ".env sets STRIPE_API_KEY, which keypin.toml maps with no dev entry; for a key add the secrets in Infisical and map them with infisical:// references (docs/infisical.md).",
    );
    expect(run.stdout.text).toContain(
      "Note: .env sets RESEND_KEY, which keypin.toml doesn't map; a plain setting can stay, and for a key add the secrets in Infisical and map them with infisical:// references (docs/infisical.md)",
    );
  });

  test("an unused [1password] pin doesn't make check suggest keypin import", async () => {
    const map = `[1password]\naccount = "my.1password.com"\n\n${MAP.replace('dev = "infisical://billing/dev/STRIPE_API_KEY"\n', "")}`;
    const run = project({ map });
    run.disk.contents.set("/work/billing/.env", `STRIPE_API_KEY=${SENTINEL}\n`);
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).not.toContain("keypin import");
    expect(run.stdout.text).toContain("add the secrets in Infisical");
  });

  test("check's TOML for an Infisical key's publish table pins no 1Password account", async () => {
    const map = `
[infisical]
organization = "acme"

[keys.STRIPE_API_KEY]
rotate_every = "90d"
dev = "infisical://billing/dev/STRIPE_API_KEY"

[keys.STRIPE_API_KEY.prod]
from = "infisical://billing/prod/STRIPE_API_KEY"
`;
    const run = project({ map });
    run.disk.folders.add("/work/billing/.github");
    run.disk.folders.add("/work/billing/.github/workflows");
    run.disk.contents.set(
      "/work/billing/.github/workflows/deploy.yml",
      "on: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: deploy\n        env:\n          STRIPE_API_KEY: ${{ secrets.STRIPE_API_KEY }}\n",
    );
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain("[[keys.STRIPE_API_KEY.prod.publish]]");
    expect(run.stdout.text).not.toContain("[1password]");
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

  test("status names rotate for an Infisical key with an issuer, even with a 1Password service account set", async () => {
    const run = project({ map: ISSUER_MAP, env: { KEYPIN_1PASSWORD: "service-account" } });
    expect(await cli(["status"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain("    Run keypin rotate STRIPE_API_KEY in /work/billing.\n");
    expect(run.stderr.text + run.stdout.text).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(run.onePassword.calls).toEqual([]);
  });

  test("rotate saves the new key to the Infisical secret and never signs in to 1Password", async () => {
    const map = ISSUER_MAP;
    const run = project({ map, env: { KEYPIN_1PASSWORD: "service-account" } });
    expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.issued).toEqual(["create STRIPE_API_KEY prod 2026-11-09"]);
    expect(run.store.effects).toEqual(["infisical update billing/prod/STRIPE_API_KEY"]);
    expect(run.store.load()[0]?.secret).toEqual({ value: ISSUED, rotated: "2026-11-09" });
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/billing",
      `write github-actions:acme/billing STRIPE_API_KEY (${ISSUED.length} chars)`,
    ]);
    expect(run.stderr.text).toContain(
      "STRIPE_API_KEY prod  from infisical://billing/prod/STRIPE_API_KEY in Infisical organization acme at https://app.infisical.com",
    );
    expect(run.stderr.text).toContain(
      "Infisical  infisical://billing/prod/STRIPE_API_KEY  saved, rotated 2026-11-09",
    );
    expect(run.stderr.text).toContain("the new key is in Infisical and the destination in the map");
    expect(run.stderr.text + run.stdout.text).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(run.stderr.text + run.stdout.text).not.toContain(ISSUED);
    expect(run.onePassword.calls).toEqual([]);
    const state = await loadState(run.disk.files, STATE);
    expect(state.receipts.map((r) => r.generation)).toEqual([
      await generationOf(new Secret(ISSUED)),
    ]);
  });
});
