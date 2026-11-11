import { describe, expect, test } from "vite-plus/test";
import { generationOf, loadState, type Receipt, Secret } from "@keypin/core";
import { GitHubSecretDestination } from "@keypin/destination-github";
import { cli } from "../src/cli";
import { NEEDS_APPROVAL } from "../src/publishing";
import {
  fakeDeps,
  type FakeDestinationOptions,
  fakeDestinations,
  fakeVault,
  leaks,
  memoryFiles,
  BILLING_MAP,
  SENTINEL,
  STATE,
} from "./fakes";

const WORKER_PLACE = "cloudflare-worker:billing-worker";
const GITHUB_PLACE = "github-actions:acme/billing";
const WORKER = `${WORKER_PLACE}:STRIPE_API_KEY`;
const GITHUB = `${GITHUB_PLACE}:STRIPE_API_KEY`;

function setup(
  options: FakeDestinationOptions & {
    terminal?: string;
    failRead?: boolean;
    disk?: ReturnType<typeof memoryFiles>;
    value?: string;
  } = {},
) {
  const disk = options.disk ?? memoryFiles({ "/work/billing/keypin.toml": BILLING_MAP });
  const vault = fakeVault({
    values: { "billing stripe api key": options.value ?? SENTINEL },
    failing: options.failRead ? ["billing stripe api key"] : [],
  });
  const destinations = fakeDestinations(options);
  const asked: string[] = [];
  const fake = fakeDeps({
    disk,
    backend: vault.vault,
    deps: {
      destination: destinations.build,
      isTerminal: options.terminal !== undefined,
      ask: async (question) => {
        asked.push(question);
        return options.terminal ?? "";
      },
    },
  });
  const state = () => loadState(disk.files, STATE);
  const everything = () => [fake.stdout.text, fake.stderr.text, ...disk.contents.values()];
  return { ...fake, disk, calls: vault.calls, log: destinations.log, asked, state, everything };
}

describe("keypin publish", () => {
  test("a first publish without a terminal stops before reading the value, exit 3", async () => {
    const run = setup();
    expect(await cli(["publish", "billing-stripe"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.log).toEqual([`check ${WORKER_PLACE}`, `check ${GITHUB_PLACE}`]);
    expect(run.calls).toEqual([]);
    expect(run.stderr.text).not.toContain("keypin: reading");
    expect(run.stderr.text).toContain(
      `  first write to ${WORKER} (account 11111111111111111111111111111111)`,
    );
    expect(run.stderr.text).toContain(`  first write to ${GITHUB} (account acme)`);
    expect(run.stderr.text).toContain("Stopped before reading the value");
    expect(run.disk.contents.has(STATE)).toBe(false);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("it prints the exact command to approve in a terminal: the folder and every argument", async () => {
    const run = setup();
    const fake = {
      ...run.deps,
      cwd: "/work/billing/src",
      self: ["/opt/bun 1.4/bun", "--no-env-file", "/home/me/keypin/apps/cli/src/main.ts"],
    };
    expect(await cli(["publish", "billing-stripe", "--env", "prod", "--yes"], fake)).toBe(
      NEEDS_APPROVAL,
    );
    expect(run.stderr.text).toContain(
      `To approve, run this in a terminal:\n  cd /work/billing/src && '/opt/bun 1.4/bun' --no-env-file /home/me/keypin/apps/cli/src/main.ts publish billing-stripe --env prod --yes\n`,
    );
    expect(run.stderr.text).not.toMatch(/(^|\s)keypin publish/m);
    expect(run.calls).toEqual([]);
  });

  test("a failed account check still comes first, before any approval", async () => {
    const run = setup({ badAccount: [GITHUB_PLACE] });
    expect(await cli(["publish", "billing-stripe"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("an account check failed");
    expect(run.stderr.text).not.toContain("needs approval");
    expect(run.calls).toEqual([]);
  });

  test("before any approval prompt it names the key, item and every destination", async () => {
    const run = setup({ terminal: "no" });
    await cli(["publish", "billing-stripe"], run.deps);
    const beforeRead = run.stderr.text.split("keypin: reading")[0] ?? "";
    expect(beforeRead).toContain(
      `Publishing billing-stripe (prod) as STRIPE_API_KEY, from item "billing stripe api key"`,
    );
    expect(beforeRead).toContain(`to: ${WORKER} (account 11111111111111111111111111111111)`);
    expect(beforeRead).toContain(`to: ${GITHUB} (account acme)`);
  });

  test("a confirmed first publish writes every destination and saves receipts", async () => {
    const run = setup({ terminal: "yes" });
    expect(await cli(["publish", "billing-stripe"], run.deps)).toBe(0);
    expect(run.asked).toHaveLength(1);
    expect(run.log.filter((l) => l.startsWith("write"))).toEqual([
      `write ${WORKER_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
      `write ${GITHUB_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
    ]);
    const state = await run.state();
    const generation = await generationOf(new Secret(SENTINEL));
    expect(state.receipts.map((r) => r.destinationId)).toEqual([WORKER, GITHUB]);
    expect(state.receipts.every((r) => r.generation === generation)).toBe(true);
    expect(state.receipts[0]).toMatchObject({
      account: {
        publisher: "me@example.com",
        destinationAccount: "11111111111111111111111111111111",
      },
      evidence: { destination: WORKER_PLACE, version: "v-3" },
    });
    expect(state.operations).toEqual([]);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("anything but yes on the terminal writes nothing", async () => {
    const run = setup({ terminal: "y" });
    expect(await cli(["publish", "billing-stripe"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("a failure at the second destination keeps the first receipt, and the rerun skips the first", async () => {
    const first = setup({ terminal: "yes", failWrite: [GITHUB_PLACE] });
    expect(await cli(["publish", "billing-stripe"], first.deps)).toBe(1);
    const state = await first.state();
    expect(state.receipts.map((r) => r.destinationId)).toEqual([WORKER]);
    expect(state.operations).toMatchObject([{ done: [WORKER], planned: [WORKER, GITHUB] }]);
    expect(leaks(...first.everything())).toBe(false);

    const again = setup({ terminal: "yes", disk: first.disk });
    expect(await cli(["publish", "billing-stripe"], again.deps)).toBe(0);
    expect(again.stderr.text).toContain("didn't finish: wrote 1 of 2");
    expect(again.stderr.text).toContain(
      `skip ${WORKER} (account 11111111111111111111111111111111): receipt already has this generation`,
    );
    expect(again.log.filter((l) => l.startsWith("write"))).toEqual([
      `write ${GITHUB_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
    ]);
    const after = await again.state();
    expect(after.receipts).toHaveLength(2);
    expect(after.operations).toEqual([]);
    expect(leaks(...again.everything())).toBe(false);
  });

  test("a failed account check reads nothing and writes nothing", async () => {
    const run = setup({ terminal: "yes", badAccount: [GITHUB_PLACE] });
    expect(await cli(["publish", "billing-stripe"], run.deps)).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.log).toEqual([`check ${WORKER_PLACE}`, `check ${GITHUB_PLACE}`]);
    expect(run.asked).toEqual([]);
    expect(run.stderr.text).toContain(`FAILED ${GITHUB} (account acme)`);
    expect(run.stderr.text).toContain("Nothing was read and nothing was written");
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("the same generation writes nothing", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "billing-stripe"], first.deps);
    const saved = first.disk.contents.get(STATE);
    const again = setup({ disk: first.disk });
    expect(await cli(["publish", "billing-stripe"], again.deps)).toBe(0);
    expect(again.log.some((l) => l.startsWith("write"))).toBe(false);
    expect(again.stderr.text).toContain("Nothing to write");
    expect(again.disk.contents.get(STATE)).toBe(saved);
  });

  test("--yes is refused when a step needs approval, and nothing is read", async () => {
    const run = setup();
    expect(await cli(["publish", "billing-stripe", "--yes"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
    expect(run.calls).toEqual([]);
    expect(run.stderr.text).toContain("--yes can't give it");
  });

  test("--yes in a terminal still asks when a step needs approval", async () => {
    const run = setup({ terminal: "no" });
    expect(await cli(["publish", "billing-stripe", "--yes"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.asked).toEqual(["Type yes to write (this plan needs approval): "]);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
  });

  test("--yes is accepted when no step needs approval", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "billing-stripe"], first.deps);
    const next = setup({ disk: first.disk, value: `${SENTINEL}-next` });
    expect(await cli(["publish", "billing-stripe", "--yes"], next.deps)).toBe(0);
    expect(next.log.filter((l) => l.startsWith("write"))).toHaveLength(2);
    expect(next.stderr.text).toContain("different generation");
    expect(next.stderr.text).not.toContain("needs approval");
    expect(leaks(...next.everything())).toBe(false);
  });

  test("without --yes or a terminal, even a plan without approval stops", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "billing-stripe"], first.deps);
    const next = setup({ disk: first.disk, value: `${SENTINEL}-next` });
    expect(await cli(["publish", "billing-stripe"], next.deps)).toBe(NEEDS_APPROVAL);
    expect(next.log.some((l) => l.startsWith("write"))).toBe(false);
  });

  test("a destination removed from the map is reported, never deleted", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "billing-stripe"], first.deps);
    first.disk.contents.set(
      "/work/billing/keypin.toml",
      BILLING_MAP.replace(/\n\s*\{ to = "github-actions", repo = "acme\/billing" \},/, ""),
    );
    const next = setup({ disk: first.disk });
    expect(await cli(["publish", "billing-stripe"], next.deps)).toBe(0);
    expect(next.stderr.text).toContain(`not in the map any more: ${GITHUB}`);
    expect(next.log).toEqual([`check ${WORKER_PLACE}`]);
  });

  test("a failed read stops before planning, naming the key and item", async () => {
    const run = setup({ terminal: "yes", failRead: true });
    expect(await cli(["publish", "billing-stripe"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `couldn't read billing-stripe (item "billing stripe api key")`,
    );
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
  });

  test("an unknown key, environment or missing entry is refused", async () => {
    const run = setup();
    expect(await cli(["publish", "nope"], run.deps)).toBe(1);
    expect(await cli(["publish", "billing-stripe", "--env", "staging"], run.deps)).toBe(2);
    expect(await cli(["publish"], run.deps)).toBe(2);
    expect(run.log).toEqual([]);
  });

  test("a publish waits for no one: a held lock exits 1, names the file, and touches nothing", async () => {
    const run = setup({ terminal: "yes" });
    run.disk.contents.set(`${STATE}.lock`, "locked\n");
    expect(await cli(["publish", "billing-stripe"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(`${STATE}.lock exists but names no process`);
    expect(run.stderr.text).toContain("delete that file");
    expect(run.log).toEqual([]);
    expect(run.calls).toEqual([]);
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("two keys publishing at once share one state file without losing receipts", async () => {
    const disk = memoryFiles({ "/work/billing/keypin.toml": TWO_KEYS_MAP });
    const backend = fakeVault({
      values: { "billing stripe api key": SENTINEL, "billing other key": `${SENTINEL}-other` },
    }).vault;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = fakeDestinations();
    const first = fakeDeps({
      disk,
      backend,
      deps: {
        isTerminal: true,
        ask: async () => {
          await gate;
          return "yes";
        },
        destination: slow.build,
      },
    });
    const second = fakeDeps({
      disk,
      backend,
      deps: { isTerminal: true, ask: async () => "yes", destination: fakeDestinations().build },
    });
    const running = cli(["publish", "billing-stripe"], first.deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cli(["publish", "billing-other"], second.deps)).toBe(1);
    expect(second.stderr.text).toContain(`holds ${STATE}.lock`);
    release();
    expect(await running).toBe(0);
    expect(disk.contents.has(`${STATE}.lock`)).toBe(false);
    expect(await cli(["publish", "billing-other"], second.deps)).toBe(0);
    const state = await loadState(disk.files, STATE);
    expect(state.receipts.map((r) => r.keyId).toSorted()).toEqual([
      "billing-other",
      "billing-stripe",
      "billing-stripe",
    ]);
  });

  test("a held lock names its process: still running, gone, or none recorded", async () => {
    for (const [holder, says] of [
      [{ pid: 4242, running: true }, "another publish or rotate (process 4242) holds"],
      [
        { pid: 4242, running: false },
        "was left by process 4242, which isn't running any more. Delete that file",
      ],
      [
        { pid: null, running: null },
        "exists but names no process. If no publish or rotate is running, delete that file",
      ],
    ] as const) {
      const run = setup({ terminal: "yes" });
      const deps = { ...run.deps, lock: async () => ({ held: false, holder }) as const };
      expect(await cli(["publish", "billing-stripe"], deps)).toBe(1);
      expect(run.stderr.text).toContain(`${STATE}.lock`);
      expect(run.stderr.text).toContain(says);
      expect(run.log).toEqual([]);
      expect(run.calls).toEqual([]);
    }
  });

  test("the lock is released after a failure", async () => {
    const run = setup({ terminal: "yes", failWrite: [GITHUB_PLACE] });
    expect(await cli(["publish", "billing-stripe"], run.deps)).toBe(1);
    expect(run.disk.contents.has(`${STATE}.lock`)).toBe(false);
  });

  test("renaming env publishes the new name after approval and reports the old one", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "billing-stripe"], first.deps);
    first.disk.contents.set(
      "/work/billing/keypin.toml",
      BILLING_MAP.replace('env = "STRIPE_API_KEY"', 'env = "STRIPE_KEY"'),
    );
    const blocked = setup({ disk: first.disk, value: SENTINEL });
    expect(await cli(["publish", "billing-stripe", "--yes"], blocked.deps)).toBe(NEEDS_APPROVAL);
    expect(blocked.stderr.text).toContain(`  first write to ${WORKER_PLACE}:STRIPE_KEY`);
    expect(blocked.calls).toEqual([]);

    const renamed = setup({ terminal: "yes", disk: first.disk });
    expect(await cli(["publish", "billing-stripe"], renamed.deps)).toBe(0);
    expect(renamed.log.filter((l) => l.startsWith("write"))).toEqual([
      `write ${WORKER_PLACE} STRIPE_KEY (${SENTINEL.length} chars)`,
      `write ${GITHUB_PLACE} STRIPE_KEY (${SENTINEL.length} chars)`,
    ]);
    expect(renamed.stderr.text).toContain(`not in the map any more: ${WORKER}`);
    expect(renamed.stderr.text).toContain(`not in the map any more: ${GITHUB}`);
    expect(renamed.stderr.text).toContain("keypin doesn't delete it");
  });

  test("an organization repo with another publisher skips on rerun with the real GitHub destination", async () => {
    const disk = memoryFiles({ "/work/billing/keypin.toml": ORG_MAP });
    const requests: string[] = [];
    const respond = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url.pathname}`);
      const reply = ORG_ROUTES.get(`${method} ${url.pathname}`) ?? { status: 404, body: {} };
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "x-oauth-scopes": "repo" },
      });
    };
    const fetch = Object.assign(respond, { preconnect: globalThis.fetch.preconnect });
    const github = () =>
      new GitHubSecretDestination({
        repo: "acme/billing",
        account: "alice",
        token: async () => "token",
        fetch,
      });
    const deps = (terminal: boolean) =>
      fakeDeps({
        disk,
        backend: fakeVault({ values: { "billing stripe api key": SENTINEL } }).vault,
        deps: { destination: github, isTerminal: terminal, ask: async () => "yes" },
      });
    const first = deps(true);
    expect(await cli(["publish", "billing-stripe"], first.deps)).toBe(0);
    const saved = await loadState(disk.files, STATE);
    expect(saved.receipts).toMatchObject([
      { account: { pinned: "alice", publisher: "alice", destinationAccount: "acme" } },
    ]);

    const again = deps(false);
    requests.length = 0;
    expect(await cli(["publish", "billing-stripe"], again.deps)).toBe(0);
    expect(again.stderr.text).toContain("receipt already has this generation");
    expect(again.stderr.text).not.toContain("account changed");
    expect(requests.some((r) => r.startsWith("PUT"))).toBe(false);
  });
});

const TWO_KEYS_MAP = `${BILLING_MAP}
[keys.billing-other]
env = "OTHER_KEY"
owner = "billing"
prod = { vault = "personal", item = "billing other key", publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "billing-worker" },
] }
`;

const ORG_MAP = `
[vaults.personal]
kind = "1password"
account = "my.1password.com"
vault = "Private"

[keys.billing-stripe]
env = "STRIPE_API_KEY"
owner = "billing"
prod = { vault = "personal", item = "billing stripe api key", publish = [
  { to = "github-actions", repo = "acme/billing", account = "alice" },
] }
`;

const ORG_ROUTES = new Map<string, { status: number; body: unknown }>([
  ["GET /user", { status: 200, body: { login: "alice" } }],
  [
    "GET /repos/acme/billing",
    { status: 200, body: { owner: { login: "acme" }, permissions: { admin: true } } },
  ],
  [
    "GET /repos/acme/billing/actions/secrets/public-key",
    { status: 200, body: { key_id: "kid", key: Buffer.alloc(32, 9).toString("base64") } },
  ],
  ["PUT /repos/acme/billing/actions/secrets/STRIPE_API_KEY", { status: 201, body: {} }],
  [
    "GET /repos/acme/billing/actions/secrets/STRIPE_API_KEY",
    { status: 200, body: { updated_at: "2026-11-09T21:00:00Z" } },
  ],
]);

describe("a destination only takes a value without approval when it came from the same item", () => {
  const ORDINARY = `${SENTINEL}-ordinary`;
  const ADMIN = `${SENTINEL}-admin`;
  const VAULTS = `[vaults.personal]\nkind = "1password"\naccount = "my.1password.com"\nvault = "Private"\n`;
  const deployMap = (item: string) =>
    `${VAULTS}\n[keys.deploy]\nenv = "DEPLOY_TOKEN"\nowner = "billing"\nprod = { vault = "personal", item = "${item}", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n`;

  function publisher(disk: ReturnType<typeof memoryFiles>, cwd: string, terminal: boolean) {
    const destinations = fakeDestinations();
    const fake = fakeDeps({
      disk,
      backend: fakeVault({
        values: { "billing deploy token": ORDINARY, "cloudflare admin token": ADMIN },
      }).vault,
      deps: { cwd, destination: destinations.build, isTerminal: terminal, ask: async () => "yes" },
    });
    const writes = () => destinations.log.filter((l) => l.startsWith("write"));
    return { ...fake, writes };
  }

  test("pointing a key at another item needs approval, and --yes without a terminal writes nothing", async () => {
    const disk = memoryFiles({ "/work/billing/keypin.toml": deployMap("billing deploy token") });
    expect(await cli(["publish", "deploy"], publisher(disk, "/work/billing", true).deps)).toBe(0);
    const before = disk.contents.get(STATE);

    disk.contents.set("/work/billing/keypin.toml", deployMap("cloudflare admin token"));
    const swapped = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "deploy", "--yes"], swapped.deps)).toBe(NEEDS_APPROVAL);
    expect(swapped.writes()).toEqual([]);
    expect(swapped.stderr.text).toContain(
      `  github-actions:acme/billing:DEPLOY_TOKEN was last published from item "billing deploy token"`,
    );
    expect(swapped.stderr.text).toContain("Stopped before reading the value");
    expect(disk.contents.get(STATE)).toBe(before);

    const approved = publisher(disk, "/work/billing", true);
    expect(await cli(["publish", "deploy"], approved.deps)).toBe(0);
    expect(approved.writes()).toHaveLength(1);
    const [saved] = (await loadState(disk.files, STATE)).receipts;
    expect(saved?.source).toEqual({
      kind: "1password",
      account: "my.1password.com",
      vault: "Private",
      item: "cloudflare admin token",
    });
    expect(leaks(...disk.contents.values(), swapped.stderr.text, approved.stderr.text)).toBe(false);
  });

  test("two keys writing the same repo secret are rejected before anything is read", async () => {
    const map = `${VAULTS}\n[keys.token-a]\nenv = "API_TOKEN"\nowner = "x"\nprod = { vault = "personal", item = "billing deploy token", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n[keys.token-b]\nenv = "API_TOKEN"\nowner = "x"\nprod = { vault = "personal", item = "cloudflare admin token", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n`;
    const run = publisher(memoryFiles({ "/work/billing/keypin.toml": map }), "/work/billing", true);
    expect(await cli(["publish", "token-a"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `key "token-b" prod publish[0]: writes the same destination secret as key "token-a" prod publish[0]`,
    );
    expect(run.writes()).toEqual([]);
  });

  test("a key's dev and prod writing the same secret are rejected", async () => {
    const map = `${VAULTS}\n[keys.deploy]\nenv = "DEPLOY_TOKEN"\nowner = "x"\ndev = { vault = "personal", item = "cloudflare admin token", publish = [{ to = "github-actions", repo = "acme/billing" }] }\nprod = { vault = "personal", item = "billing deploy token", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n`;
    const run = publisher(memoryFiles({ "/work/billing/keypin.toml": map }), "/work/billing", true);
    expect(await cli(["publish", "deploy"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `key "deploy" prod publish[0]: writes the same destination secret as key "deploy" dev publish[0]`,
    );
    expect(run.writes()).toEqual([]);
  });

  test("the same key ID in another project, from another item, needs approval for the first project's secret", async () => {
    const disk = memoryFiles({
      "/work/billing/keypin.toml": deployMap("billing deploy token"),
      "/work/web/keypin.toml": deployMap("cloudflare admin token"),
    });
    expect(await cli(["publish", "deploy"], publisher(disk, "/work/billing", true).deps)).toBe(0);
    const other = publisher(disk, "/work/web", false);
    expect(await cli(["publish", "deploy", "--yes"], other.deps)).toBe(NEEDS_APPROVAL);
    expect(other.stderr.text).toContain("needs approval");
    expect(other.writes()).toEqual([]);
  });

  test("another project writing the same GitHub secret in another case makes the next write need approval", async () => {
    const named = (name: string, item: string) =>
      `${VAULTS}\n[keys.deploy]\nenv = "${name}"\nowner = "x"\nprod = { vault = "personal", item = "${item}", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n`;
    const disk = memoryFiles({
      "/work/billing/keypin.toml": named("TOKEN", "billing deploy token"),
      "/work/web/keypin.toml": named("token", "cloudflare admin token"),
    });
    expect(await cli(["publish", "deploy"], publisher(disk, "/work/billing", true).deps)).toBe(0);
    expect(await cli(["publish", "deploy"], publisher(disk, "/work/web", true).deps)).toBe(0);
    expect((await loadState(disk.files, STATE)).receipts).toHaveLength(1);

    const again = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "deploy", "--yes"], again.deps)).toBe(NEEDS_APPROVAL);
    expect(again.stderr.text).toContain('was last published from item "cloudflare admin token"');
    expect(again.writes()).toEqual([]);
  });

  test("a state file from version 1 loads, and each destination needs approval once", async () => {
    const disk = memoryFiles({ "/work/billing/keypin.toml": deployMap("billing deploy token") });
    expect(await cli(["publish", "deploy"], publisher(disk, "/work/billing", true).deps)).toBe(0);
    const current = await loadState(disk.files, STATE);
    disk.contents.set(
      STATE,
      JSON.stringify({
        version: 1,
        operations: [],
        receipts: current.receipts.map((r) => withoutSource(r)),
      }),
    );

    const unattended = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "deploy", "--yes"], unattended.deps)).toBe(NEEDS_APPROVAL);
    expect(unattended.stderr.text).toContain("an item its receipt doesn't record");
    expect(unattended.writes()).toEqual([]);

    expect(await cli(["publish", "deploy"], publisher(disk, "/work/billing", true).deps)).toBe(0);
    const rerun = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "deploy", "--yes"], rerun.deps)).toBe(0);
    expect(rerun.stderr.text).toContain("receipt already has this generation");
    expect(rerun.writes()).toEqual([]);
  });
});

function withoutSource(receipt: Receipt): Omit<Receipt, "source"> {
  const { keyId, environment, destinationId, generation, account, at, evidence } = receipt;
  return { keyId, environment, destinationId, generation, account, at, evidence };
}
