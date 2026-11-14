import { assert, describe, expect, test, vi } from "vite-plus/test";
import { isRecord, type KeyRef } from "@keypin/core";
import type { SdkClient } from "@keypin/vault-1password";
import { cli } from "../src/cli";
import type { Deps } from "../src/deps";
import { onePasswordFrom } from "../src/sign-in";
import {
  BILLING_MAP,
  ESC,
  fakeDeps,
  fakeDestinations,
  fakeLauncher,
  fakeVault,
  memoryFiles,
  parseJson,
  REGISTRY,
  registryWith,
  SENTINEL,
  unstyled,
  WEB_MAP,
} from "./fakes";

const tokenFor = (address: string) =>
  `ops_${Buffer.from(JSON.stringify({ signInAddress: address })).toString("base64url")}`;
const TOKEN = tokenFor("my.1password.com");
const SERVICE = { KEYPIN_1PASSWORD: "service-account", OP_SERVICE_ACCOUNT_TOKEN: TOKEN };
const ID = "4Q6Z73JHSJESBM36AP3W57YOOU";
const DEPLOY_MAP = BILLING_MAP.replaceAll("op://Private/", "op://Deploy/");

function sdk(items: string[] = ["billing stripe api key"]) {
  const calls: string[] = [];
  const client: SdkClient = {
    vaults: {
      list: async () => {
        calls.push("vaults.list");
        return [{ id: "deploy", title: "Deploy" }];
      },
    },
    items: {
      list: async () => {
        calls.push("items.list");
        return items.map((title) => ({ id: title, title, tags: [], updatedAt: new Date() }));
      },
      get: async () => {
        throw new Error("this test gets no item");
      },
      create: async () => ({}),
      put: async () => ({}),
    },
  };
  return { client, calls };
}

function opened(env: Record<string, string>, client = sdk().client) {
  const connects: string[] = [];
  const onePassword = onePasswordFrom(env, {
    desktop: async (account) => {
      connects.push(`desktop ${account}`);
      return client;
    },
    token: async (token) => {
      connects.push(token === TOKEN ? "token" : "another token");
      return client;
    },
  });
  return { ...onePassword, connects };
}

function project(map = DEPLOY_MAP, env: Record<string, string> = SERVICE, client = sdk()) {
  const disk = memoryFiles({
    "/work/billing/keypin.toml": map,
    [REGISTRY]: registryWith("/work/billing"),
  });
  const onePassword = opened(env, client.client);
  const fake = fakeDeps({
    disk,
    deps: {
      env,
      signIn: () => onePassword.signIn,
      vault: () => onePassword.vault,
      destination: fakeDestinations().build,
    },
  });
  return { ...fake, connects: onePassword.connects, calls: client.calls };
}

function json(text: string): Record<string, unknown> {
  const data = parseJson(text);
  assert(isRecord(data));
  return data;
}

describe("choosing how keypin signs in to 1Password", () => {
  test("unset or desktop uses the desktop app; service-account uses the token", () => {
    expect(opened({}).signIn).toEqual({ mode: "desktop", tokenIgnored: false });
    expect(opened({ KEYPIN_1PASSWORD: "desktop" }).signIn).toEqual({
      mode: "desktop",
      tokenIgnored: false,
    });
    expect(opened(SERVICE).signIn).toEqual({
      mode: "service-account",
      address: "my.1password.com",
    });
  });

  test("a token without KEYPIN_1PASSWORD still uses the desktop app, and says it ignored the token", () => {
    expect(opened({ OP_SERVICE_ACCOUNT_TOKEN: TOKEN }).signIn).toEqual({
      mode: "desktop",
      tokenIgnored: true,
    });
    expect(opened({ KEYPIN_1PASSWORD: "desktop", OP_SERVICE_ACCOUNT_TOKEN: TOKEN }).signIn).toEqual(
      { mode: "desktop", tokenIgnored: false },
    );
  });

  test("any other KEYPIN_1PASSWORD is a usage error naming the allowed values", async () => {
    const run = project(BILLING_MAP, {});
    run.deps.signIn = () => opened({ KEYPIN_1PASSWORD: "token" }).signIn;
    expect(await cli(["check"], run.deps)).toBe(2);
    expect(run.stderr.text).toContain(
      "keypin check: KEYPIN_1PASSWORD must be desktop or service-account\n",
    );
  });

  test("service-account with no token fails, and never falls back to the desktop app", async () => {
    for (const token of [undefined, ""]) {
      const env: Record<string, string> = { KEYPIN_1PASSWORD: "service-account" };
      if (token !== undefined) env.OP_SERVICE_ACCOUNT_TOKEN = token;
      const run = project(BILLING_MAP, {});
      const connects: string[] = [];
      const pick = () =>
        onePasswordFrom(env, {
          desktop: async () => {
            connects.push("desktop");
            return sdk().client;
          },
          token: async () => {
            connects.push("token");
            return sdk().client;
          },
        });
      run.deps.signIn = () => pick().signIn;
      run.deps.vault = () => pick().vault;
      expect(await cli(["status"], run.deps)).toBe(1);
      expect(run.stderr.text).toContain(
        "KEYPIN_1PASSWORD=service-account needs the service account's token in OP_SERVICE_ACCOUNT_TOKEN, which is unset or empty",
      );
      expect(connects).toEqual([]);
    }
  });

  test("a token that fails to sign in never falls back to the desktop app", async () => {
    const connects: string[] = [];
    const onePassword = onePasswordFrom(SERVICE, {
      desktop: async () => {
        connects.push("desktop");
        return sdk().client;
      },
      token: async () => {
        connects.push("token");
        throw new Error("invalid service account token");
      },
    });
    const run = project();
    run.deps.signIn = () => onePassword.signIn;
    run.deps.vault = () => onePassword.vault;
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(connects).toEqual(["token"]);
    expect(run.stdout.text).toContain("Sign in to 1Password with the service account");
    expect(run.stdout.text).toContain(
      "Check that OP_SERVICE_ACCOUNT_TOKEN holds a current service account token",
    );
    expect(run.stdout.text).not.toContain("desktop app");
  });
});

describe("keypin check with a service account", () => {
  test("--json says which sign-in it used, with no token data", async () => {
    const run = project();
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    expect(json(run.stdout.text).onePassword).toEqual({
      signIn: "service-account",
      address: "my.1password.com",
    });
    expect(run.stdout.text + run.stderr.text).not.toContain(TOKEN);
  });

  test("my.1password.com: one note that keypin can't prove the account", async () => {
    const run = project();
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text.match(/Note: every individual 1Password account/g)).toHaveLength(1);
    expect(run.stdout.text).toContain(
      "Note: every individual 1Password account signs in at my.1password.com, so keypin can't prove the service account belongs to the account keypin.toml pins; the vaults granted to the service account are what limit it\n",
    );
  });

  test("a team address gets no such note", async () => {
    const env = { ...SERVICE, OP_SERVICE_ACCOUNT_TOKEN: tokenFor("acme.1password.com") };
    const run = project(DEPLOY_MAP.replace("my.1password.com", "acme.1password.com"), env);
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).not.toContain("every individual 1Password account");
  });

  test("a token while signed in with the desktop app: one note naming KEYPIN_1PASSWORD", async () => {
    const run = project(DEPLOY_MAP, { OP_SERVICE_ACCOUNT_TOKEN: TOKEN });
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.connects).toEqual(["desktop my.1password.com"]);
    expect(run.stdout.text).toContain(
      "Note: OP_SERVICE_ACCOUNT_TOKEN is set, but keypin signed in with the 1Password desktop app; set KEYPIN_1PASSWORD=service-account to use the service account\n",
    );
    expect(json((await jsonRun(DEPLOY_MAP, { OP_SERVICE_ACCOUNT_TOKEN: TOKEN })).text)).toEqual(
      expect.objectContaining({ onePassword: { signIn: "desktop", address: null } }),
    );
  });

  test("a map pinning another account is refused before any vault call, with its own step", async () => {
    const run = project(DEPLOY_MAP.replace("my.1password.com", "acme.1password.com"));
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.connects).toEqual([]);
    expect(run.stdout.text).toContain(
      "Sign in to 1Password with the service account\n  Use a service account token for the account keypin.toml pins; OP_SERVICE_ACCOUNT_TOKEN signs in to my.1password.com.",
    );
    expect(run.stdout.text).not.toContain("1Password app lists");
  });

  test("a map pinning an account ID is accepted, with one note that the ID can't be checked", async () => {
    const run = project(DEPLOY_MAP.replace("my.1password.com", ID));
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.connects).toEqual(["token"]);
    expect(run.calls).toEqual(["vaults.list", "items.list"]);
    expect(run.stdout.text.match(/^Note: .*service account.*$/gm)).toEqual([
      `Note: keypin.toml pins the account ID ${ID}, which a service account token can't be checked against, so the vaults granted to the service account are what limit it`,
    ]);
  });

  test("an ID pin with a my.1password.com token gets one note, not two", async () => {
    const run = project(DEPLOY_MAP.replace("my.1password.com", ID));
    await cli(["check"], run.deps);
    expect(run.stdout.text).not.toContain("every individual 1Password account");
    expect(run.stdout.text.match(/what limit it/g)).toHaveLength(1);
  });

  test("an item in Private says service accounts can't open built-in vaults", async () => {
    const run = project(BILLING_MAP);
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      `service accounts can't open the built-in vault "Private"; move the item to a vault you create, update its reference in keypin.toml, and grant the service account read access to that vault`,
    );
    expect(run.stdout.text).not.toContain("Sign in to 1Password");
  });
});

async function jsonRun(map: string, env: Record<string, string>) {
  const run = project(map, env);
  await cli(["check", "--json"], run.deps);
  return run.stdout;
}

describe("keypin import with a service account", () => {
  test("is refused before reading the env file, listing or planning", async () => {
    const vault = fakeVault({ items: [] });
    const run = fakeDeps({
      disk: memoryFiles({ "/work/billing/.env": `STRIPE_KEY=${SENTINEL}\n` }),
      backend: vault.vault,
      deps: { signIn: () => ({ mode: "service-account", address: "my.1password.com" }) },
    });
    expect(await cli(["import", ".env", "--vault", "Deploy", "--yes"], run.deps)).toBe(1);
    expect(run.stderr.text).toBe(
      "keypin import: import writes new items to 1Password, which needs the desktop app; KEYPIN_1PASSWORD=service-account only reads\n",
    );
    expect(vault.calls).toEqual([]);
    expect(vault.created).toEqual([]);
  });
});

describe("keypin run with a service account", () => {
  function running(env: Record<string, string>, map = WEB_MAP) {
    const launcher = fakeLauncher();
    const vault = fakeVault({
      values: { "web dev session secret": SENTINEL, "op token": "mapped-token-value" },
    });
    const run = fakeDeps({
      disk: memoryFiles({ "/work/billing/keypin.toml": map }),
      backend: vault.vault,
      deps: {
        env: { PATH: "/usr/bin", ...env },
        signIn: () => ({ mode: "service-account", address: "my.1password.com" }),
        launch: launcher.launch,
        onSignals: launcher.onSignals,
      },
    });
    return { ...run, launcher };
  }

  test("the command gets the mapped keys, never OP_SERVICE_ACCOUNT_TOKEN or KEYPIN_1PASSWORD", async () => {
    const run = running(SERVICE);
    expect(await cli(["run", "--", "env"], run.deps)).toBe(0);
    expect(run.launcher.launches[0]?.env).toEqual({
      PATH: "/usr/bin",
      SESSION_SECRET: SENTINEL,
    });
  });

  test("a mapped key named OP_SERVICE_ACCOUNT_TOKEN is refused, and nothing starts", async () => {
    const map = `${WEB_MAP}\n[keys.OP_SERVICE_ACCOUNT_TOKEN]\nrotate_every = "never"\ndev = "op://Private/op token/password"\n`;
    const run = running(SERVICE, map);
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "keypin.toml maps OP_SERVICE_ACCOUNT_TOKEN, which keypin uses to sign in to 1Password; keypin run doesn't pass it to a command",
    );
    expect(run.launcher.launches).toEqual([]);
  });
});

describe("the approval hint", () => {
  async function slowFrames(
    args: string[],
    signIn: ReturnType<Deps["signIn"]>,
    files: Record<string, string>,
  ) {
    vi.useFakeTimers();
    try {
      const vault = fakeVault({
        values: { "web dev session secret": SENTINEL, "billing stripe api key": SENTINEL },
      });
      const later = () => new Promise((resolve) => setTimeout(resolve, 1500));
      const fast = { ...vault.vault };
      Object.assign(vault.vault, {
        read: async (ref: KeyRef) => later().then(() => fast.read(ref)),
        itemIds: async (ref: KeyRef) => later().then(() => fast.itemIds(ref)),
        metadata: async (ref: KeyRef) => later().then(() => fast.metadata(ref)),
      });
      const launcher = fakeLauncher();
      const run = fakeDeps({
        disk: memoryFiles(files),
        backend: vault.vault,
        deps: {
          cwd: "/work/web",
          signIn: () => signIn,
          launch: launcher.launch,
          onSignals: launcher.onSignals,
          destination: fakeDestinations().build,
          styled: { stdout: true, stderr: true },
          columns: () => 120,
        },
      });
      let code: number | undefined;
      void cli(args, run.deps).then((c) => (code = c));
      while (code === undefined) await vi.advanceTimersByTimeAsync(100);
      return run.stderr.text
        .split(`\r${ESC}[2K`)
        .map((frame) => unstyled(frame))
        .filter((frame) => frame && !frame.includes("\n"));
    } finally {
      vi.useRealTimers();
    }
  }

  const files = {
    "/work/web/keypin.toml": WEB_MAP,
    [REGISTRY]: registryWith("/work/web"),
  };
  const service = { mode: "service-account", address: "my.1password.com" } as const;
  const desktop = { mode: "desktop", tokenIgnored: false } as const;

  for (const args of [["run", "--", "true"], ["check"], ["status"]])
    test(`keypin ${args[0]} shows it only with the desktop app`, async () => {
      const slow = (frames: string[]) =>
        frames.filter((f) => f.includes("Reading") || f.includes("Looking"));
      const withApp = await slowFrames(args, desktop, files);
      expect(withApp.some((f) => f.includes("1Password may be asking you to approve keypin"))).toBe(
        true,
      );
      const withToken = await slowFrames(args, service, files);
      expect(slow(withToken).length).toBeGreaterThan(0);
      expect(withToken.some((f) => f.includes("approve keypin"))).toBe(false);
    });
});

describe("keypin status with a service account", () => {
  test("a project pinning another account is skipped with the error; the token never tries it", async () => {
    const other = WEB_MAP.replace("my.1password.com", "acme.1password.com").replaceAll(
      "op://Private/",
      "op://Deploy/",
    );
    const client = sdk(["billing stripe api key"]);
    const onePassword = opened(SERVICE, client.client);
    const run = fakeDeps({
      disk: memoryFiles({
        [REGISTRY]: registryWith("/work/billing", "/work/web"),
        "/work/billing/keypin.toml": DEPLOY_MAP,
        "/work/web/keypin.toml": other,
      }),
      deps: { signIn: () => onePassword.signIn, vault: () => onePassword.vault },
    });
    await cli(["status"], run.deps);
    expect(onePassword.connects).toEqual(["token"]);
    expect(run.stderr.text).toContain(
      "the service account signs in to my.1password.com, but keypin.toml pins acme.1password.com",
    );
    expect(run.stderr.text + run.stdout.text).not.toContain(TOKEN);
  });
});
