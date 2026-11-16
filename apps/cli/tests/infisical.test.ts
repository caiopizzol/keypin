import { describe, expect, test } from "vite-plus/test";
import { generationOf, type Issuer, loadState, Secret } from "@keypin/core";
import { credentialsFrom, infisicalBackend } from "@keypin/connectors/infisical";
import { cli } from "../src/cli";
import { vaults } from "../src/start";
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
import {
  type FakeInfisical,
  infisicalFetch,
  memoryStore,
  mergeHeld,
} from "@keypin/connectors/infisical/testing";

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
    failWrite?: string[];
    isTerminal?: boolean;
  } = {},
) {
  const disk =
    options.after?.disk ??
    memoryFiles({
      "/work/billing/keypin.toml": options.map ?? MAP,
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
  const infisical = infisicalBackend(
    credentialsFrom(env),
    infisicalFetch(options.infisical ?? INFISICAL, store),
  );
  const launcher = fakeLauncher();
  const destinations = fakeDestinations({ failWrite: options.failWrite ?? [] });
  const issued: string[] = [];
  const keys = options.after?.keys ?? new Set<string>();
  const issuer: Issuer = {
    describe: () => "Resend",
    dashboard: () => "https://resend.com/api-keys",
    checkAccount: async (id) => ({
      ok: id === null || keys.has(id),
      facts: `the admin key lists ${keys.size} API keys`,
    }),
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
      launch: launcher.launch,
      onSignals: launcher.onSignals,
      destination: destinations.build,
      issuer: () => issuer,
      isTerminal: options.isTerminal ?? true,
      ask: async () => "y",
    },
  });
  return { ...fake, launcher, destinations, store, onePassword, issued, keys };
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
    expect(run.issued).toEqual(["create STRIPE_API_KEY prod 2026-11-09 12:00:00"]);
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
      expect(held.issued).toEqual(["create STRIPE_API_KEY prod 2026-11-09 12:00:00"]);
      expect(held.store.effects.at(-1)).toBe("infisical hold update billing/prod/STRIPE_API_KEY");
      expect(infisical.heldByPolicy?.[0]?.secret.value).toBe(SECOND);
      expect(held.stderr.text).toContain("Infisical holds the change for approval");
      expect(held.stderr.text).toContain(
        "The new key key-2 at Resend stays valid: the change holds it.",
      );
      expect(held.stderr.text).toContain(
        "Once someone approves it, run this again to publish the new key and revoke the old one:",
      );
      expect(held.stderr.text).toContain(
        "If the change is rejected or cancelled, delete key key-2 at https://resend.com/api-keys, then run this again.",
      );
      expect(held.stderr.text).not.toContain("isn't in Infisical");
      expect(held.destinations.log).toEqual(["check github-actions:acme/billing"]);
      const state = await loadState(held.disk.files, STATE, vaults);
      expect(state.issued).toMatchObject([
        { id: "key-2", generation: await generationOf(new Secret(SECOND)), held: true },
      ]);
      expect(held.keys.has("key-2")).toBe(true);
    });

    function stateWritesFail(disk: Earlier["disk"], after: number) {
      const files = { ...disk.files };
      let left = after;
      disk.files.write = async (path, text) => {
        if (path.startsWith(STATE) && left-- <= 0)
          throw new Error("ENOSPC: no space left on device");
        return files.write(path, text);
      };
      return () => (left = Infinity);
    }

    test("a state write that fails after the save is held still waits on the rerun", async () => {
      const infisical = policy();
      const first = project({ map: ISSUER_MAP, infisical });
      expect(await cli(["rotate", "STRIPE_API_KEY"], first.deps)).toBe(0);
      infisical.heldByPolicy = [];
      const restore = stateWritesFail(first.disk, 1);
      const held = project({ map: ISSUER_MAP, infisical, after: first });
      expect(await cli(["rotate", "STRIPE_API_KEY"], held.deps)).not.toBe(0);
      expect(held.store.effects.at(-1)).toBe("infisical hold update billing/prod/STRIPE_API_KEY");
      restore();

      const again = project({ map: ISSUER_MAP, infisical, after: held });
      expect(await cli(["rotate", "STRIPE_API_KEY"], again.deps)).toBe(3);
      expect(again.issued).toEqual([]);
      expect(again.stderr.text).toContain(
        "Stopped: Infisical still holds the change that saves key key-2 for approval. Nothing was created.",
      );
      expect(again.stderr.text).not.toContain("If nothing uses it, delete it");
      expect((await loadState(again.disk.files, STATE, vaults)).issued).toMatchObject([
        { id: "key-2", held: true },
      ]);
    });

    test("a failed save whose state write also fails says to delete the key, then creates a new one", async () => {
      const infisical = policy();
      const first = project({ map: ISSUER_MAP, infisical });
      expect(await cli(["rotate", "STRIPE_API_KEY"], first.deps)).toBe(0);
      infisical.failWrites = true;
      const restore = stateWritesFail(first.disk, 1);
      const failed = project({ map: ISSUER_MAP, infisical, after: first });
      expect(await cli(["rotate", "STRIPE_API_KEY"], failed.deps)).toBe(1);
      expect(failed.stderr.text).toContain(
        "Stopped: the new key key-2 exists at Resend but isn't in Infisical, and keypin can't show it again. Delete it at https://resend.com/api-keys, then run this again:",
      );
      restore();
      infisical.failWrites = false;
      failed.keys.delete("key-2");

      const again = project({ map: ISSUER_MAP, infisical, after: failed });
      expect(await cli(["rotate", "STRIPE_API_KEY"], again.deps)).toBe(0);
      expect(again.stderr.text).toContain(
        "Key key-2 is gone from Resend, so keypin creates a new one.",
      );
      expect(again.issued).toEqual([
        "create STRIPE_API_KEY prod 2026-11-09 12:00:00",
        "revoke key-1",
      ]);
    });

    test("a saved key leaves no pending mark, and the next rotation replaces it", async () => {
      const infisical = policy();
      const first = project({ map: ISSUER_MAP, infisical });
      expect(await cli(["rotate", "STRIPE_API_KEY"], first.deps)).toBe(0);
      expect((await loadState(first.disk.files, STATE, vaults)).issued[0]).not.toHaveProperty(
        "held",
      );
      const next = project({ map: ISSUER_MAP, infisical, after: first });
      expect(await cli(["rotate", "STRIPE_API_KEY"], next.deps)).toBe(0);
      expect(next.issued).toEqual([
        "create STRIPE_API_KEY prod 2026-11-09 12:00:00",
        "revoke key-1",
      ]);
      expect(next.stderr.text).not.toContain("If nothing uses it, delete it");
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
      expect(infisical.heldByPolicy).toHaveLength(1);
    });

    test("--plan while the change is held points to a rerun without --plan", async () => {
      const { infisical, held } = await heldRotation();
      const waiting = project({ map: ISSUER_MAP, infisical, after: held });
      expect(await cli(["rotate", "STRIPE_API_KEY", "--plan"], waiting.deps)).toBe(3);
      expect(waiting.issued).toEqual([]);
      expect(waiting.stderr.text).toMatch(
        /run this again to publish the new key and revoke the old one:\n.* rotate STRIPE_API_KEY\n/,
      );
    });

    test("a rerun after the change is rejected and its key deleted creates a new key", async () => {
      const { infisical, held } = await heldRotation();
      infisical.heldByPolicy = undefined;
      held.keys.delete("key-2");
      const again = project({ map: ISSUER_MAP, infisical, after: held });
      expect(await cli(["rotate", "STRIPE_API_KEY"], again.deps)).toBe(0);
      expect(again.stderr.text).toContain(
        "Key key-2 is gone from Resend, so keypin creates a new one.",
      );
      expect(again.issued).toEqual([
        "create STRIPE_API_KEY prod 2026-11-09 12:00:00",
        "revoke key-1",
      ]);
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
      const state = await loadState(resumed.disk.files, STATE, vaults);
      expect(state.issued).toMatchObject([{ id: "key-2", held: false, old: { revoked: true } }]);
    });
  });

  describe("a source Infisical imports from another environment", () => {
    const IMPORTED_MAP = ISSUER_MAP.replace(
      '{ to = "github-actions", repo = "acme/billing" },]',
      '{ to = "github-actions", repo = "acme/billing" }, { to = "github-actions", repo = "acme/web" }]',
    );
    const imported = (): FakeInfisical => {
      const { STRIPE_API_KEY, ...prod } = structuredClone(INFISICAL.projects.billing?.prod ?? {});
      return {
        organization: "acme",
        projects: { billing: { prod } },
        importedForReads: {
          billing: { prod: { STRIPE_API_KEY: STRIPE_API_KEY ?? { value: "" } } },
        },
      };
    };
    const LOCAL = { vault: "billing", item: "billing/prod/STRIPE_API_KEY" };

    test("receipts carry the local secret rotate saves, so the next plan sees no item change", async () => {
      const infisical = imported();
      const run = project({ map: ISSUER_MAP, infisical });
      expect(await cli(["rotate", "STRIPE_API_KEY"], run.deps)).toBe(0);
      expect(run.store.effects).toEqual(["infisical create billing/prod/STRIPE_API_KEY"]);
      const state = await loadState(run.disk.files, STATE, vaults);
      expect(state.receipts.map((r) => r.sourceIds)).toEqual([LOCAL]);
      const plan = project({ map: ISSUER_MAP, infisical, after: run, isTerminal: false });
      expect(await cli(["publish", "STRIPE_API_KEY", "--plan"], plan.deps)).toBe(0);
      expect(plan.stderr.text).not.toContain("was last published from");
      const again = project({ map: ISSUER_MAP, infisical, after: run, isTerminal: false });
      await cli(["rotate", "STRIPE_API_KEY", "--yes"], again.deps);
      expect(again.stderr.text).not.toContain("Needs approval");
      expect(again.issued).toEqual(["create STRIPE_API_KEY prod 2026-11-09 12:00:00"]);
    });

    test("a resumed partial publish writes only the destination that failed", async () => {
      const infisical = imported();
      const failed = project({
        map: IMPORTED_MAP,
        infisical,
        failWrite: ["github-actions:acme/web"],
      });
      expect(await cli(["rotate", "STRIPE_API_KEY"], failed.deps)).toBe(1);
      const resumed = project({ map: IMPORTED_MAP, infisical, after: failed });
      expect(await cli(["rotate", "STRIPE_API_KEY"], resumed.deps)).toBe(0);
      expect(resumed.issued).toEqual([]);
      expect(resumed.destinations.log).toEqual([
        "check github-actions:acme/billing",
        "check github-actions:acme/web",
        `write github-actions:acme/web STRIPE_API_KEY (${ISSUED.length} chars)`,
      ]);
      const state = await loadState(resumed.disk.files, STATE, vaults);
      expect(state.receipts.map((r) => r.sourceIds)).toEqual([LOCAL, LOCAL]);
    });
  });
});
