import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, describe, expect, test, vi } from "vite-plus/test";
import { isRecord, type PublishTarget } from "@keypin/core";
import { fakeSignIn } from "@keypin/connectors/cloudflare/testing";
import { GitHubSecretDestination } from "@keypin/connectors/github";
import {
  type FullItem,
  onePasswordBackend,
  requireDesktopApp,
} from "@keypin/connectors/onepassword";
import { fakeOnePassword, field, item } from "@keypin/connectors/onepassword/testing";
import { cli } from "../src/cli";
import { routedVault } from "../src/vault";
import { destination as realDestination, signInNames } from "../src/start";
import type { Deps } from "../src/deps";
import {
  BILLING_MAP,
  fakeDeps,
  fakeDestinations,
  fakeVault,
  leaks,
  memoryFiles,
  parseJson,
  REGISTRY,
  registryWith,
  SENTINEL,
  STATE,
} from "./fakes";
import { recording } from "./recording";

const MAP_FILE = "/work/billing/secretspec.toml";

function setup(
  options: {
    map?: string;
    values?: Record<string, string>;
    badAccount?: string[];
    deps?: Partial<Deps>;
  } = {},
) {
  const disk = memoryFiles({
    [MAP_FILE]: options.map ?? BILLING_MAP,
    [REGISTRY]: registryWith("/work/billing"),
  });
  const before = new Map(disk.contents);
  const vault = fakeVault({ values: options.values ?? { "billing stripe api key": SENTINEL } });
  const destinations = fakeDestinations({ badAccount: options.badAccount });
  const fake = fakeDeps({
    disk,
    backend: vault.vault,
    deps: {
      destination: destinations.build,
      workerSignIn: () => fakeSignIn("oauth"),
      ...options.deps,
    },
  });
  const unchanged = () => expect(disk.contents).toEqual(before);
  const everything = () => [fake.stdout.text, fake.stderr.text, ...disk.contents.values()];
  const record = async (
    name: string,
    args: string[],
    more: { given?: Record<string, unknown>; calls?: Record<string, readonly string[]> } = {},
  ) => {
    const exit = await cli(args, fake.deps);
    await expect(
      recording({
        args,
        exit,
        stdout: fake.stdout.text,
        stderr: fake.stderr.text,
        files: { "secretspec.toml": before.get(MAP_FILE) ?? "" },
        given: { "bad accounts": options.badAccount, ...more.given },
        calls: { vault: vault.calls, destination: destinations.log, ...more.calls },
      }),
    ).toMatchFileSnapshot(`./recordings/check/${name}.txt`);
    return exit;
  };
  return { ...fake, calls: vault.calls, log: destinations.log, unchanged, everything, record };
}

function report(text: string) {
  const data = parseJson(text);
  assert(isRecord(data));
  const { keys, problems } = data;
  assert(Array.isArray(keys) && Array.isArray(problems));
  return { ...data, keys: keys.map((key: unknown) => key), problems };
}

describe("keypin check", () => {
  test("a good setup checks every item and account, writes nothing, and exits 0", async () => {
    const run = setup();
    expect(await run.record("good-setup", ["check"])).toBe(0);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
    run.unchanged();
    expect(run.disk.contents.has(STATE)).toBe(false);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("the all-good line counts keys and destinations, and nothing else is listed", async () => {
    const run = setup({
      map: `${BILLING_MAP}

[profiles.prod.OTHER_KEY]
description = "OTHER_KEY"
ref = { item = "billing stripe api key", field = "password" }

[tool.keypin.prod.OTHER_KEY]
publish = [{ to = "github-actions", repo = "acme/billing" }]
`,
    });
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).toContain("ok     2 keys, 3 destinations. Everything checks out.\n");
    expect(run.stdout.text).not.toContain("things to do");
    expect(run.stdout.text).not.toContain("acme/billing");
  });

  test("works without a terminal and never asks", async () => {
    const run = setup({
      deps: {
        isTerminal: false,
        ask: async () => {
          throw new Error("check asked a question");
        },
      },
    });
    expect(await cli(["check"], run.deps)).toBe(0);
  });

  test("names the login from git config github.account", async () => {
    const run = setup({
      badAccount: ["github-actions:acme/billing"],
      deps: {
        git: async (_folder, args) =>
          args.join(" ") === "config --get github.account" ? "alice\n" : null,
      },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      "  secretspec.toml names acme; the login is alice (git config github.account), signed in as acme.\n",
    );
  });

  test("a missing item is one problem line naming the keys that use it, exit 1", async () => {
    const run = setup({ values: {} });
    expect(
      await run.record("missing-item", ["check"], { given: { vault: "holds no items" } }),
    ).toBe(1);
    run.unchanged();
  });

  test("an issuer's admin item is looked up like a key's item, and a missing one names the key", async () => {
    const map = BILLING_MAP.replace(
      'rotate_every = "365d"',
      'rotate_every = "365d"\nissuer = { kind = "resend", admin = "op://Private/resend admin key/credential", permission = "sending_access" }',
    );
    const run = setup({ map });
    expect(await run.record("missing-admin-item", ["check"])).toBe(1);
    expect(run.calls).toContain("ids resend admin key");
    expect(run.stdout.text).toContain("Used by STRIPE_API_KEY (prod) as its issuer's admin key.");
    run.unchanged();

    const found = setup({
      map,
      values: { "billing stripe api key": SENTINEL, "resend admin key": "re_admin_value" },
    });
    expect(await cli(["check"], found.deps), found.stdout.text).toBe(0);
    expect(found.calls).toContain("ids resend admin key");
    expect(found.calls.some((call) => call.startsWith("read"))).toBe(false);
  });

  test("through the real 1Password backend, check lists items and never gets one", async () => {
    const stored: FullItem = {
      id: "item-1",
      title: "billing stripe api key",
      category: "Password",
      vaultId: "vault-1",
      fields: [{ id: "credential", title: "credential", fieldType: "Concealed", value: SENTINEL }],
      sections: [],
      notes: "",
      tags: [],
      websites: [],
      version: 1,
      files: [],
      createdAt: new Date("2026-11-01T00:00:00Z"),
      updatedAt: new Date("2026-11-09T12:00:00Z"),
    };
    const sdk: string[] = [];
    const titles = ["billing stripe api key"];
    const backend = () =>
      onePasswordBackend(async () => ({
        vaults: {
          list: async () => [{ id: "vault-1", title: "Private", vaultType: "personal" as const }],
        },
        items: {
          list: async () => {
            sdk.push("list");
            return titles.map((title) => ({
              id: stored.id,
              title,
              tags: [],
              updatedAt: new Date(),
            }));
          },
          get: async () => {
            sdk.push("get");
            return stored;
          },
          create: async () => {
            sdk.push("create");
            return stored;
          },
          put: async () => {
            sdk.push("put");
            return stored;
          },
        },
      }));
    const first = backend();
    const run = setup({ deps: { vault: () => first } });
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    expect(sdk).toEqual(["list"]);
    expect(parseJson(run.stdout.text)).toHaveProperty(
      "notes",
      expect.arrayContaining([
        expect.stringContaining(
          "items are looked up in each vault's item list, which holds no values, so no field is checked",
        ),
      ]),
    );

    titles.pop();
    const second = backend();
    const missing = setup({ deps: { vault: () => second } });
    expect(await cli(["check"], missing.deps)).toBe(1);
    expect(missing.stdout.text).toContain(
      "  op://Private/billing stripe api key/password (1Password account my.1password.com): no such item.\n  Used by STRIPE_API_KEY (dev), STRIPE_API_KEY (prod).\n",
    );
    expect(sdk).not.toContain("get");
    expect(leaks(...run.everything(), ...missing.everything())).toBe(false);
  });

  test("an account mismatch names the login, publisher, account reached, and the fix", async () => {
    const routes = new Map<string, { status: number; body: unknown }>([
      ["GET /user", { status: 200, body: { login: "bob" } }],
      [
        "GET /repos/acme/billing",
        { status: 200, body: { owner: { login: "acme" }, permissions: { push: false } } },
      ],
    ]);
    const respond = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const reply = routes.get(`${init?.method ?? "GET"} ${url.pathname}`) ?? {
        status: 404,
        body: {},
      };
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "x-oauth-scopes": "repo" },
      });
    };
    const fetch = Object.assign(respond, { preconnect: globalThis.fetch.preconnect });
    const workers = fakeDestinations();
    const run = setup({
      deps: {
        destination: (target, publisher) =>
          target.to === "github-actions" && target.repo !== undefined
            ? new GitHubSecretDestination({
                repo: target.repo,
                login: publisher.githubLogin,
                token: async () => "token",
                fetch,
              })
            : workers.build(target),
      },
    });
    const given = { "GitHub API": Object.fromEntries(routes) };
    expect(
      await run.record("account-mismatch", ["check", "--json"], {
        given,
        calls: { destination: workers.log },
      }),
    ).toBe(1);
  });

  test("a failed account check is a problem; nothing is read twice or written", async () => {
    const run = setup({ badAccount: ["cloudflare-worker:billing-worker"] });
    expect(await run.record("failed-account-check", ["check"])).toBe(1);
    run.unchanged();
  });

  test("names the Cloudflare sign-in it used: KEYPIN_CLOUDFLARE_API_TOKEN", async () => {
    const run = setup({
      badAccount: ["cloudflare-worker:billing-worker"],
      deps: { workerSignIn: () => fakeSignIn("api-token") },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      `the login is the API token in KEYPIN_CLOUDFLARE_API_TOKEN, signed in as me@example.com.`,
    );
  });

  test("a step that fails says so, instead of saying it finished", async () => {
    const run = setup({ values: {}, badAccount: ["cloudflare-worker:billing-worker"] });
    const given = { vault: "holds no items" };
    expect(await run.record("failed-steps", ["check"], { given })).toBe(1);
  });

  test("a GitHub login that can't publish is one step with the gh sign-in, not two", async () => {
    const run = setup({
      badAccount: ["github-actions:acme/billing"],
      deps: { ghLogin: async () => "not logged in" },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain("1 thing to do:\n1 Sign in to GitHub\n");
    expect(run.stdout.text).not.toContain("Fix the login");
    await cli(["check", "--json"], run.deps);
    const data = report(run.stdout.text.slice(run.stdout.text.indexOf("{")));
    expect(data.problems).toHaveLength(1);
  });

  test("keys in the account's default Shared vault get a note that scheduled rotation can't read them", async () => {
    const stored = {
      ...item("billing stripe api key", [field("password", "Concealed", SENTINEL)]),
      vaultId: "vault-Shared",
    };
    const backend = onePasswordBackend(async () => fakeOnePassword([stored]).client);
    const vault = routedVault({ "1password": () => backend });
    const run = setup({
      map: BILLING_MAP.replace("@Private", "@Shared"),
      deps: { vault: () => vault },
    });
    const given = { "1Password vaults": 'Private (type "personal"), Shared (type "everyone")' };
    expect(await run.record("default-shared-vault", ["check"], { given })).toBe(0);
  });

  test("an account the 1Password app doesn't have says to fix the map, not the app", async () => {
    const error =
      "An error occurred when processing SDK request: Error { msg: Account not found, inner: None }";
    const vault = onePasswordBackend(async () => {
      throw new Error(error);
    });
    const run = setup({ deps: { vault: () => vault } });
    const given = { "1Password SDK throws": error };
    expect(await run.record("unknown-1password-account", ["check"], { given })).toBe(1);
  });

  test("without the 1Password desktop app, says to install it, or use a service account on a server", async () => {
    let tries = 0;
    const vault = onePasswordBackend(
      requireDesktopApp(
        async () => {
          tries += 1;
          throw new Error("Native library is not available.");
        },
        () => null,
      ),
    );
    const run = setup({
      map: `${BILLING_MAP}\n\n[profiles.dev.OTHER]\ndescription = "OTHER"\nref = { item = "other key", field = "password" }\n`,
      deps: { vault: () => vault },
    });
    const given = { "1Password desktop app": "not installed" };
    expect(await run.record("no-desktop-app", ["check"], { given })).toBe(1);
    expect(tries).toBe(0);
  });

  test("with a Snap or Flatpak desktop app, says to install the .deb or .rpm package, not to install the app", async () => {
    const vault = onePasswordBackend(
      requireDesktopApp(
        async () => {
          throw new Error("Native library is not available.");
        },
        () => null,
        () => true,
      ),
    );
    const run = setup({ deps: { vault: () => vault } });
    const given = { "1Password desktop app": "a Snap or Flatpak" };
    expect(await run.record("sandboxed-desktop-app", ["check"], { given })).toBe(1);
  });

  test("a map that doesn't parse lists its errors, reads nothing, exit 1", async () => {
    const run = setup({
      map: `${BILLING_MAP}\n[tool.keypin.dev.STRIPE_API_KEY]\nrotate_every = "soon"\n`,
    });
    expect(await run.record("map-does-not-parse", ["check", "--json"])).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.log).toEqual([]);
  });

  test("an empty map is a problem, not a healthy setup", async () => {
    const run = setup({ map: "" });
    expect(await run.record("empty-map", ["check"])).toBe(1);
    expect(run.calls).toEqual([]);
  });

  test("no map anywhere above the folder is a problem", async () => {
    const run = setup();
    run.disk.contents.delete(MAP_FILE);
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      "Create secretspec.toml\n  There's no secretspec.toml in /work/billing or any folder above it.\n    secretspec init\n",
    );
  });

  test("an unregistered project joins keypin status's list, once", async () => {
    const run = setup();
    run.disk.contents.set(REGISTRY, registryWith());
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain("keypin status now lists /work/billing");
    expect(run.disk.contents.get(REGISTRY)).toContain('"/work/billing"');
    const again = run.stderr.text.length;
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stderr.text.slice(again)).not.toContain("now lists");
  });

  test("a registry keypin can't write is a warning; check still reports", async () => {
    const run = setup();
    run.disk.contents.set(REGISTRY, registryWith());
    const write = run.disk.files.write.bind(run.disk.files);
    run.disk.files.write = async (path, text) => {
      if (path.startsWith("/home/me/.config/keypin/")) throw new Error("read-only file system");
      return write(path, text);
    };
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain(
      "keypin status can't list /work/billing: read-only file system",
    );
    const report: unknown = JSON.parse(run.stdout.text);
    assert(isRecord(report));
    expect(report.registered).toBe(false);
  });

  test("no map anywhere above the folder registers nothing", async () => {
    const run = setup();
    run.disk.contents.delete(MAP_FILE);
    run.disk.contents.set(REGISTRY, registryWith());
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.disk.contents.get(REGISTRY)).not.toContain('"/work/billing"');
  });

  test("the --json shape", async () => {
    const run = setup();
    expect(await run.record("json", ["check", "/work/billing", "--json"])).toBe(0);
    expect(leaks(...run.everything())).toBe(false);
  });

  describe("the real GitHub destination's gh token", () => {
    let bin: string | undefined;
    const path = process.env.PATH;

    afterEach(async () => {
      vi.unstubAllGlobals();
      process.env.PATH = path;
      if (bin) await rm(bin, { recursive: true, force: true });
      bin = undefined;
    });

    async function fakeGh(): Promise<() => Promise<string[]>> {
      bin = await mkdtemp(join(tmpdir(), "keypin-check-gh-"));
      const log = join(bin, "log");
      await writeFile(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${log}"\necho token\n`);
      await chmod(join(bin, "gh"), 0o755);
      process.env.PATH = `${bin}:/usr/bin:/bin`;
      vi.stubGlobal(
        "fetch",
        async (input: string) =>
          new Response(
            JSON.stringify(
              new URL(input).pathname === "/user"
                ? { login: "alice" }
                : { owner: { login: "acme" }, permissions: { push: true } },
            ),
            { status: 200, headers: { "x-oauth-scopes": "repo" } },
          ),
      );
      return async () => (await readFile(log, "utf8")).trim().split("\n");
    }

    test("check asks gh with --no-refresh, so an expired gh token isn't refreshed", async () => {
      const asked = await fakeGh();
      const workers = fakeDestinations();
      const run = setup({
        deps: {
          git: async (_folder, args) =>
            args.join(" ") === "config --get github.account" ? "alice\n" : null,
          destination: (target, publisher) =>
            target.to === "github-actions"
              ? realDestination(target, publisher)
              : workers.build(target),
        },
      });
      expect(await cli(["check"], run.deps)).toBe(0);
      expect(await asked()).toEqual(["auth token --hostname github.com --user alice --no-refresh"]);
    });

    test("publish's publisher still lets gh refresh", async () => {
      const asked = await fakeGh();
      const target: PublishTarget = { to: "github-actions", repo: "acme/billing", account: "acme" };
      const check = await realDestination(target, {
        githubLogin: "alice",
        workerSignIn: null,
        signInEnv: {},
        refreshLogins: true,
        signInVariables: signInNames,
      }).checkAccount();
      expect(check.ok).toBe(true);
      expect(await asked()).toEqual(["auth token --hostname github.com --user alice"]);
    });
  });
});
