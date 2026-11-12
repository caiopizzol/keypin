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

const ROTATE_MAP = `
[1password]
account = "my.1password.com"

[keys.CLOUDFLARE_API_TOKEN]
rotate_every = "90d"

[keys.CLOUDFLARE_API_TOKEN.prod]
from = "op://Private/billing cloudflare token/credential"

[[keys.CLOUDFLARE_API_TOKEN.prod.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"

[keys.CLOUDFLARE_API_TOKEN.prod.rotate]
provider = "cloudflare-account-token"
account = "${ACCOUNT}"
admin = "op://Private/cloudflare token admin/credential"
`;

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
      "keypin: reading each value to check that its item and field exist (none is printed) from 1Password account my.1password.com: op://Private/billing stripe api key/password\n",
    );
    expect(run.calls).toEqual(["read billing stripe api key"]);
    expect(run.log).toEqual([
      `check cloudflare-worker:billing-worker`,
      `check github-actions:acme/billing`,
    ]);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
    const text = run.stdout.text;
    expect(text).toContain(
      "STRIPE_API_KEY (dev)\n  ok     from op://Private/billing stripe api key/password",
    );
    expect(text).toContain(
      `  ok     github-actions:acme/billing:STRIPE_API_KEY: login the active gh login, publisher acme, pinned account acme, reaches acme`,
    );
    expect(text).toContain(
      `  ok     cloudflare-worker:${ACCOUNT}:billing-worker:STRIPE_API_KEY: login the wrangler login in ${WRANGLER}, publisher me@example.com, pinned account ${ACCOUNT}, reaches ${ACCOUNT}`,
    );
    expect(text).toContain(
      `the wrangler login is an OAuth token stored in plain text in ${WRANGLER}`,
    );
    expect(text).toContain("Everything checks out.");
    run.unchanged();
    expect(run.disk.contents.has(STATE)).toBe(false);
    expect(leaks(...run.everything())).toBe(false);
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
      deps: {
        git: async (_folder, args) =>
          args.join(" ") === "config --get github.account" ? "alice\n" : null,
      },
    });
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).toContain("login alice (git config github.account)");
  });

  test("a missing item is one problem line naming the keys that use it, exit 1", async () => {
    const run = setup({ values: {} });
    expect(await cli(["check"], run.deps)).toBe(1);
    const text = run.stdout.text;
    expect(text).toContain("  FAILED from op://Private/billing stripe api key/password");
    expect(text).toContain(
      `Problems (1):\n  no item "billing stripe api key" (STRIPE_API_KEY (dev), STRIPE_API_KEY (prod))\n`,
    );
    run.unchanged();
  });

  test("a missing field, through the real 1Password backend, is a problem", async () => {
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
    const writes: string[] = [];
    const backend = onePasswordBackend(async () => ({
      vaults: { list: async () => [{ id: "vault-1", title: "Private" }] },
      items: {
        list: async () => [{ id: stored.id, title: stored.title, tags: [], updatedAt: new Date() }],
        get: async () => stored,
        create: async () => {
          writes.push("create");
          return stored;
        },
        put: async () => {
          writes.push("put");
          return stored;
        },
      },
    }));
    const run = setup({ deps: { vault: () => backend } });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      `  op://Private/billing stripe api key/password (1Password account my.1password.com): the item has no field "password" (STRIPE_API_KEY (dev), STRIPE_API_KEY (prod))`,
    );
    expect(writes).toEqual([]);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("an empty field is a problem, and its value is never shown", async () => {
    const run = setup({ values: { "billing stripe api key": "" } });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(`the field "password" is empty`);
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

  test("a rotate section's missing admin item is a problem", async () => {
    const run = setup({
      map: ROTATE_MAP,
      values: { "billing cloudflare token": SENTINEL },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.calls).toEqual(["read billing cloudflare token", "read cloudflare token admin"]);
    const text = run.stdout.text;
    expect(text).toContain("  ok     from op://Private/billing cloudflare token/credential");
    expect(text).toContain("  FAILED rotate admin op://Private/cloudflare token admin/credential");
    expect(text).toContain(
      `  no item "cloudflare token admin" (CLOUDFLARE_API_TOKEN (prod) rotate admin)`,
    );
  });

  test("a rotate section whose admin item exists checks out", async () => {
    const run = setup({
      map: ROTATE_MAP,
      values: {
        "billing cloudflare token": SENTINEL,
        "cloudflare token admin": `${SENTINEL}-admin`,
      },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    const data = report(run.stdout.text);
    expect(data.keys[0]).toMatchObject({
      rotateAdmin: { reference: "op://Private/cloudflare token admin/credential", ok: true },
    });
    expect(leaks(...run.everything())).toBe(false);
  });

  test("a failed account check is a problem; nothing is read twice or written", async () => {
    const run = setup({ badAccount: ["cloudflare-worker:billing-worker"] });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      `  cloudflare-worker:${ACCOUNT}/billing-worker: the login can't reach ${ACCOUNT} (STRIPE_API_KEY (prod))`,
    );
    expect(run.log.filter((l) => l.startsWith("check"))).toHaveLength(2);
    run.unchanged();
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
    expect(run.stdout.text).toContain(`${MAP_FILE} maps no keys yet`);
  });

  test("no map anywhere above the folder is a problem", async () => {
    const run = setup();
    run.disk.contents.delete(MAP_FILE);
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain("no keypin.toml in /work/billing or any folder above it");
  });

  test("an unregistered project gets a note, not a problem", async () => {
    const run = setup();
    run.disk.contents.set(REGISTRY, registryWith());
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).toContain("/work/billing isn't registered");
  });

  test("the --json shape", async () => {
    const run = setup();
    expect(await cli(["check", "/work/billing", "--json"], run.deps)).toBe(0);
    const data = report(run.stdout.text);
    expect(Object.keys(data)).toEqual([
      "folder",
      "map",
      "registered",
      "keys",
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
      rotateAdmin: null,
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

    test("publish and rotate's publisher still lets gh refresh", async () => {
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
