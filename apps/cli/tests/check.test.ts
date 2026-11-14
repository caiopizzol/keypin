import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, describe, expect, test, vi } from "vite-plus/test";
import { isRecord, type PublishTarget } from "@keypin/core";
import { GitHubSecretDestination } from "@keypin/destination-github";
import { type FullItem, onePasswordBackend } from "@keypin/vault-1password";
import { cli } from "../src/cli";
import { destination as realDestination } from "../src/start";
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

const ACCOUNT = "11111111111111111111111111111111";
const MAP_FILE = "/work/billing/keypin.toml";
const WRANGLER = "/home/me/Library/Preferences/.wrangler/config/default.toml";
const TILDE_WRANGLER = "~/Library/Preferences/.wrangler/config/default.toml";

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
      wranglerLoginFile: async () => WRANGLER,
      ...options.deps,
    },
  });
  const unchanged = () => expect(disk.contents).toEqual(before);
  const everything = () => [fake.stdout.text, fake.stderr.text, ...disk.contents.values()];
  return { ...fake, calls: vault.calls, log: destinations.log, unchanged, everything };
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
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain(
      "ok     Looked up 1 item in 1Password account my.1password.com, not the values\n",
    );
    expect(run.calls).toEqual(["ids billing stripe api key"]);
    expect(run.log).toEqual([
      `check cloudflare-worker:billing-worker`,
      `check github-actions:acme/billing`,
    ]);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
    expect(run.stdout.text)
      .toBe(`billing /work/billing · read 0 env files, 0 wrangler configs, 0 workflows
ok     1 key, 2 destinations. Everything checks out.
Note: the wrangler login is an OAuth token stored in plain text in ${TILDE_WRANGLER}; wrangler logout removes it
`);
    run.unchanged();
    expect(run.disk.contents.has(STATE)).toBe(false);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("the all-good line counts keys and destinations, and nothing else is listed", async () => {
    const run = setup({
      map: `${BILLING_MAP}
[keys.OTHER_KEY]
prod = { from = "op://Private/billing stripe api key/password", publish = [
  { to = "github-actions", repo = "acme/billing" },
] }
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
      "  keypin.toml pins acme; the login is alice (git config github.account), signed in as acme.\n",
    );
  });

  test("a missing item is one problem line naming the keys that use it, exit 1", async () => {
    const run = setup({ values: {} });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(`1 thing to do:
1 Fix the vault item op://Private/billing stripe api key/password
  No item "billing stripe api key".
  Used by STRIPE_API_KEY (dev), STRIPE_API_KEY (prod).
`);
    run.unchanged();
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
    const backend = onePasswordBackend(async () => ({
      vaults: { list: async () => [{ id: "vault-1", title: "Private" }] },
      items: {
        list: async () => {
          sdk.push("list");
          return titles.map((title) => ({ id: stored.id, title, tags: [], updatedAt: new Date() }));
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
    const run = setup({ deps: { vault: () => backend } });
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
    const missing = setup({ deps: { vault: () => backend } });
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
          target.to === "github-actions"
            ? new GitHubSecretDestination({
                repo: target.repo,
                login: publisher.githubLogin,
                token: async () => "token",
                fetch,
              })
            : workers.build(target),
      },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = report(run.stdout.text);
    const [dev, prod] = data.keys;
    assert(isRecord(prod) && Array.isArray(prod.destinations));
    expect(dev).toMatchObject({ key: "STRIPE_API_KEY", environment: "dev", destinations: [] });
    expect(prod.destinations[1]).toEqual({
      destination: "github-actions:acme/billing:STRIPE_API_KEY",
      to: "github-actions",
      login: "the active gh login",
      publisher: "bob",
      pinned: "acme",
      reached: "acme",
      ok: false,
      problem:
        "bob has no write access to acme/billing, so GitHub won't let it set Actions secrets",
      fix: "ask an admin of acme for the Write role, or publish as another login: git config github.account <login>",
    });
    expect(data.problems).toEqual([
      "github-actions:acme/billing: bob has no write access to acme/billing, so GitHub won't let it set Actions secrets; fix: ask an admin of acme for the Write role, or publish as another login: git config github.account <login> (STRIPE_API_KEY (prod))",
    ]);
  });

  test("a failed account check is a problem; nothing is read twice or written", async () => {
    const run = setup({ badAccount: ["cloudflare-worker:billing-worker"] });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(`1 thing to do:
1 Fix the login for the Worker billing-worker
  The login can't reach ${ACCOUNT}.
  keypin.toml pins ${ACCOUNT}; the login is the wrangler login in ${TILDE_WRANGLER}, signed in as me@example.com.
  Used by STRIPE_API_KEY (prod).
`);
    expect(run.log.filter((l) => l.startsWith("check"))).toHaveLength(2);
    run.unchanged();
  });

  test("a step that fails says so, instead of saying it finished", async () => {
    const run = setup({ values: {}, badAccount: ["cloudflare-worker:billing-worker"] });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stderr.text).toBe(
      [
        "FAILED Couldn't look up 1 of 1 item in 1Password account my.1password.com, not the values",
        "FAILED 1 of 2 accounts failed the check",
        "",
      ].join("\n"),
    );
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

  test("an account the 1Password app doesn't have says to fix the map, not the app", async () => {
    const vault = onePasswordBackend(async () => {
      throw new Error(
        "An error occurred when processing SDK request: Error { msg: Account not found, inner: None }",
      );
    });
    const run = setup({ deps: { vault: () => vault } });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(`1 Sign in to 1Password
  Set account under [1password] in keypin.toml to a sign-in address or account ID the 1Password app lists, under Settings → Accounts.
  1Password account "my.1password.com": sign-in failed: the 1Password app has no account with this sign-in address or ID.
`);
    expect(run.stdout.text).not.toContain("Error {");
    expect(run.stdout.text).not.toContain("Integrate with other apps");
  });

  test("a map that doesn't parse lists its errors, reads nothing, exit 1", async () => {
    const run = setup({ map: `${BILLING_MAP}\n[keys.BAD]\nrotate_every = "soon"\n` });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = report(run.stdout.text);
    expect(data.problems).toEqual([
      `${MAP_FILE}: key "BAD": field "rotate_every" must be <n>d, <n>w, <n>m or never`,
      `${MAP_FILE}: key "BAD": needs at least one of "dev", "prod"`,
    ]);
    expect(run.calls).toEqual([]);
    expect(run.log).toEqual([]);
  });

  test("an empty map is a problem, not a healthy setup", async () => {
    const run = setup({ map: "" });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(`2 Map a key\n  ${MAP_FILE} maps no keys yet.\n`);
    expect(run.calls).toEqual([]);
  });

  test("no map anywhere above the folder is a problem", async () => {
    const run = setup();
    run.disk.contents.delete(MAP_FILE);
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      "Create keypin.toml\n  There's no keypin.toml in /work/billing or any folder above it.\n    keypin init\n",
    );
  });

  test("an unregistered project gets a note, not a problem", async () => {
    const run = setup();
    run.disk.contents.set(REGISTRY, registryWith());
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).toContain("Note: /work/billing isn't registered");
  });

  test("the --json shape", async () => {
    const run = setup();
    expect(await cli(["check", "/work/billing", "--json"], run.deps)).toBe(0);
    const data = report(run.stdout.text);
    expect(Object.keys(data)).toEqual([
      "folder",
      "map",
      "registered",
      "read",
      "github",
      "keys",
      "production",
      "local",
      "add",
      "unknown",
      "prerequisites",
      "notes",
      "problems",
      "ok",
    ]);
    expect(data).toMatchObject({
      folder: "/work/billing",
      map: MAP_FILE,
      registered: true,
      problems: [],
      ok: true,
    });
    expect(data.keys[1]).toEqual({
      key: "STRIPE_API_KEY",
      environment: "prod",
      from: { reference: "op://Private/billing stripe api key/password", ok: true, problem: null },
      destinations: [
        {
          destination: `cloudflare-worker:${ACCOUNT}:billing-worker:STRIPE_API_KEY`,
          to: "cloudflare-worker",
          login: `the wrangler login in ${WRANGLER}`,
          publisher: "me@example.com",
          pinned: ACCOUNT,
          reached: ACCOUNT,
          ok: true,
          problem: null,
          fix: null,
        },
        {
          destination: "github-actions:acme/billing:STRIPE_API_KEY",
          to: "github-actions",
          login: "the active gh login",
          publisher: "acme",
          pinned: "acme",
          reached: "acme",
          ok: true,
          problem: null,
          fix: null,
        },
      ],
    });
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
        refreshLogins: true,
      }).checkAccount();
      expect(check.ok).toBe(true);
      expect(await asked()).toEqual(["auth token --hostname github.com --user alice"]);
    });
  });
});
