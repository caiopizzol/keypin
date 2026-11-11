import { describe, expect, test } from "vite-plus/test";
import { generationOf, loadState, type Receipt, Secret } from "@keypin/core";
import { GitHubSecretDestination } from "@keypin/destination-github";
import { type FullItem, onePasswordBackend } from "@keypin/vault-1password";
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
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(NEEDS_APPROVAL);
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
    expect(await cli(["publish", "STRIPE_API_KEY", "--env", "prod", "--yes"], fake)).toBe(
      NEEDS_APPROVAL,
    );
    expect(run.stderr.text).toContain(
      `To approve, run this in a terminal:\n  cd /work/billing/src && '/opt/bun 1.4/bun' --no-env-file /home/me/keypin/apps/cli/src/main.ts publish STRIPE_API_KEY --env prod --yes\n`,
    );
    expect(run.stderr.text).not.toMatch(/(^|\s)keypin publish/m);
    expect(run.calls).toEqual([]);
  });

  test("a failed account check still comes first, before any approval", async () => {
    const run = setup({ badAccount: [GITHUB_PLACE] });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("an account check failed");
    expect(run.stderr.text).not.toContain("needs approval");
    expect(run.calls).toEqual([]);
  });

  test("before any approval prompt it names the key, item and every destination", async () => {
    const run = setup({ terminal: "no" });
    await cli(["publish", "STRIPE_API_KEY"], run.deps);
    const beforeRead = run.stderr.text.split("keypin: reading")[0] ?? "";
    expect(beforeRead).toContain(
      `Publishing STRIPE_API_KEY (prod) from op://Private/billing stripe api key/password`,
    );
    expect(beforeRead).toContain(`to: ${WORKER} (account 11111111111111111111111111111111)`);
    expect(beforeRead).toContain(`to: ${GITHUB} (account acme)`);
  });

  test("a confirmed first publish writes every destination and saves receipts", async () => {
    const run = setup({ terminal: "yes" });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
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
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("a failure at the second destination keeps the first receipt, and the rerun skips the first", async () => {
    const first = setup({ terminal: "yes", failWrite: [GITHUB_PLACE] });
    expect(await cli(["publish", "STRIPE_API_KEY"], first.deps)).toBe(1);
    const state = await first.state();
    expect(state.receipts.map((r) => r.destinationId)).toEqual([WORKER]);
    expect(state.operations).toMatchObject([{ done: [WORKER], planned: [WORKER, GITHUB] }]);
    expect(leaks(...first.everything())).toBe(false);

    const again = setup({ terminal: "yes", disk: first.disk });
    expect(await cli(["publish", "STRIPE_API_KEY"], again.deps)).toBe(0);
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
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.log).toEqual([`check ${WORKER_PLACE}`, `check ${GITHUB_PLACE}`]);
    expect(run.asked).toEqual([]);
    expect(run.stderr.text).toContain(`FAILED ${GITHUB} (account acme)`);
    expect(run.stderr.text).toContain("Nothing was read and nothing was written");
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("the same generation writes nothing", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "STRIPE_API_KEY"], first.deps);
    const saved = first.disk.contents.get(STATE);
    const again = setup({ disk: first.disk });
    expect(await cli(["publish", "STRIPE_API_KEY"], again.deps)).toBe(0);
    expect(again.log.some((l) => l.startsWith("write"))).toBe(false);
    expect(again.stderr.text).toContain("Nothing to write");
    expect(again.disk.contents.get(STATE)).toBe(saved);
  });

  test("--yes is refused when a step needs approval, and nothing is read", async () => {
    const run = setup();
    expect(await cli(["publish", "STRIPE_API_KEY", "--yes"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
    expect(run.calls).toEqual([]);
    expect(run.stderr.text).toContain("--yes can't give it");
  });

  test("--yes in a terminal still asks when a step needs approval", async () => {
    const run = setup({ terminal: "no" });
    expect(await cli(["publish", "STRIPE_API_KEY", "--yes"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.asked).toEqual(["Type yes to write (this plan needs approval): "]);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
  });

  test("--yes is accepted when no step needs approval", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "STRIPE_API_KEY"], first.deps);
    const next = setup({ disk: first.disk, value: `${SENTINEL}-next` });
    expect(await cli(["publish", "STRIPE_API_KEY", "--yes"], next.deps)).toBe(0);
    expect(next.log.filter((l) => l.startsWith("write"))).toHaveLength(2);
    expect(next.stderr.text).toContain("different generation");
    expect(next.stderr.text).not.toContain("needs approval");
    expect(leaks(...next.everything())).toBe(false);
  });

  test("without --yes or a terminal, even a plan without approval stops", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "STRIPE_API_KEY"], first.deps);
    const next = setup({ disk: first.disk, value: `${SENTINEL}-next` });
    expect(await cli(["publish", "STRIPE_API_KEY"], next.deps)).toBe(NEEDS_APPROVAL);
    expect(next.log.some((l) => l.startsWith("write"))).toBe(false);
  });

  test("--plan without a terminal reads the value, shows the full plan, and writes nothing", async () => {
    const run = setup();
    const before = new Map(run.disk.contents);
    expect(await cli(["publish", "STRIPE_API_KEY", "--plan"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.calls).toEqual(["read billing stripe api key"]);
    expect(run.log).toEqual([`check ${WORKER_PLACE}`, `check ${GITHUB_PLACE}`]);
    expect(run.disk.contents).toEqual(before);
    const text = run.stderr.text;
    const generation = await generationOf(new Secret(SENTINEL));
    expect(text).toContain(`  ok ${WORKER} (account 11111111111111111111111111111111)`);
    expect(text).toContain(`Plan for generation ${generation}:`);
    expect(text).toContain(`  write ${GITHUB} (account acme): no receipt`);
    expect(text).toContain(`    needs approval: first write to ${GITHUB} (account acme)`);
    expect(text).toContain("This plan needs yes typed in a terminal; --yes can't approve it.");
    expect(text).toContain(
      "To approve, run this in a terminal:\n  cd /work/billing && /opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts publish STRIPE_API_KEY\n",
    );
    expect(leaks(...run.everything())).toBe(false);
  });

  test("--plan labels a routine update, and neither --yes nor a terminal makes it write", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "STRIPE_API_KEY"], first.deps);
    const saved = first.disk.contents.get(STATE);
    const next = setup({ disk: first.disk, value: `${SENTINEL}-next`, terminal: "yes" });
    expect(await cli(["publish", "STRIPE_API_KEY", "--plan", "--yes"], next.deps)).toBe(
      NEEDS_APPROVAL,
    );
    expect(next.asked).toEqual([]);
    expect(next.log.some((l) => l.startsWith("write"))).toBe(false);
    expect(next.disk.contents.get(STATE)).toBe(saved);
    expect(next.stderr.text).toContain("different generation");
    expect(next.stderr.text).toContain("This plan is routine: --yes can approve it.");
    expect(next.stderr.text).toContain("main.ts publish STRIPE_API_KEY --yes\n");
    expect(leaks(...next.everything())).toBe(false);
  });

  test("--plan stops at a failed account check, and has nothing to approve when up to date", async () => {
    const failed = setup({ badAccount: [GITHUB_PLACE] });
    expect(await cli(["publish", "STRIPE_API_KEY", "--plan"], failed.deps)).toBe(1);
    expect(failed.calls).toEqual([]);

    const first = setup({ terminal: "yes" });
    await cli(["publish", "STRIPE_API_KEY"], first.deps);
    const again = setup({ disk: first.disk });
    expect(await cli(["publish", "STRIPE_API_KEY", "--plan"], again.deps)).toBe(0);
    expect(again.stderr.text).toContain("Nothing to write");
    expect(again.stderr.text).not.toContain("To approve");
  });

  test("a destination removed from the map is reported, never deleted", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "STRIPE_API_KEY"], first.deps);
    first.disk.contents.set(
      "/work/billing/keypin.toml",
      BILLING_MAP.replace(/\n\s*\{ to = "github-actions", repo = "acme\/billing" \},/, ""),
    );
    const next = setup({ disk: first.disk });
    expect(await cli(["publish", "STRIPE_API_KEY"], next.deps)).toBe(0);
    expect(next.stderr.text).toContain(`not in the map any more: ${GITHUB}`);
    expect(next.log).toEqual([`check ${WORKER_PLACE}`]);
  });

  test("a failed read stops before planning, naming the key and item", async () => {
    const run = setup({ terminal: "yes", failRead: true });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `couldn't read STRIPE_API_KEY (op://Private/billing stripe api key/password)`,
    );
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
  });

  test("an unknown key, environment or missing entry is refused", async () => {
    const run = setup();
    expect(await cli(["publish", "nope"], run.deps)).toBe(1);
    expect(await cli(["publish", "STRIPE_API_KEY", "--env", "staging"], run.deps)).toBe(2);
    expect(await cli(["publish"], run.deps)).toBe(2);
    expect(run.log).toEqual([]);
  });

  test("a publish waits for no one: a held lock exits 1, names the file, and touches nothing", async () => {
    const run = setup({ terminal: "yes" });
    run.disk.contents.set(`${STATE}.lock`, "locked\n");
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(1);
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
    const running = cli(["publish", "STRIPE_API_KEY"], first.deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cli(["publish", "OTHER_KEY"], second.deps)).toBe(1);
    expect(second.stderr.text).toContain(`holds ${STATE}.lock`);
    release();
    expect(await running).toBe(0);
    expect(disk.contents.has(`${STATE}.lock`)).toBe(false);
    expect(await cli(["publish", "OTHER_KEY"], second.deps)).toBe(0);
    const state = await loadState(disk.files, STATE);
    expect(state.receipts.map((r) => r.keyId).toSorted()).toEqual([
      "OTHER_KEY",
      "STRIPE_API_KEY",
      "STRIPE_API_KEY",
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
      expect(await cli(["publish", "STRIPE_API_KEY"], deps)).toBe(1);
      expect(run.stderr.text).toContain(`${STATE}.lock`);
      expect(run.stderr.text).toContain(says);
      expect(run.log).toEqual([]);
      expect(run.calls).toEqual([]);
    }
  });

  test("the lock is released after a failure", async () => {
    const run = setup({ terminal: "yes", failWrite: [GITHUB_PLACE] });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.disk.contents.has(`${STATE}.lock`)).toBe(false);
  });

  test("renaming a key's variable publishes the new name after approval, and never deletes the old", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "STRIPE_API_KEY"], first.deps);
    first.disk.contents.set(
      "/work/billing/keypin.toml",
      BILLING_MAP.replace("[keys.STRIPE_API_KEY]", "[keys.STRIPE_KEY]"),
    );
    const blocked = setup({ disk: first.disk, value: SENTINEL });
    expect(await cli(["publish", "STRIPE_KEY", "--yes"], blocked.deps)).toBe(NEEDS_APPROVAL);
    expect(blocked.stderr.text).toContain(`  first write to ${WORKER_PLACE}:STRIPE_KEY`);
    expect(blocked.calls).toEqual([]);

    const renamed = setup({ terminal: "yes", disk: first.disk });
    expect(await cli(["publish", "STRIPE_KEY"], renamed.deps)).toBe(0);
    expect(renamed.log.filter((l) => l.startsWith("write"))).toEqual([
      `write ${WORKER_PLACE} STRIPE_KEY (${SENTINEL.length} chars)`,
      `write ${GITHUB_PLACE} STRIPE_KEY (${SENTINEL.length} chars)`,
    ]);
    expect(renamed.log.some((l) => l.startsWith("delete"))).toBe(false);
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
    expect(await cli(["publish", "STRIPE_API_KEY"], first.deps)).toBe(0);
    const saved = await loadState(disk.files, STATE);
    expect(saved.receipts).toMatchObject([
      { account: { pinned: "alice", publisher: "alice", destinationAccount: "acme" } },
    ]);

    const again = deps(false);
    requests.length = 0;
    expect(await cli(["publish", "STRIPE_API_KEY"], again.deps)).toBe(0);
    expect(again.stderr.text).toContain("receipt already has this generation");
    expect(again.stderr.text).not.toContain("account changed");
    expect(requests.some((r) => r.startsWith("PUT"))).toBe(false);
  });
});

const TWO_KEYS_MAP = `${BILLING_MAP}
[keys.OTHER_KEY]
prod = { from = "op://Private/billing other key/password", publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "billing-worker" },
] }
`;

const ORG_MAP = `
[1password]
account = "my.1password.com"

[keys.STRIPE_API_KEY]
prod = { from = "op://Private/billing stripe api key/password", publish = [
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
  const VAULTS = `[1password]\naccount = "my.1password.com"\n`;
  const deployMap = (item: string) =>
    `${VAULTS}\n[keys.DEPLOY_TOKEN]\nprod = { from = "op://Private/${item}/password", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n`;

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
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);
    const before = disk.contents.get(STATE);

    disk.contents.set("/work/billing/keypin.toml", deployMap("cloudflare admin token"));
    const swapped = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], swapped.deps)).toBe(NEEDS_APPROVAL);
    expect(swapped.writes()).toEqual([]);
    expect(swapped.stderr.text).toContain(
      `  github-actions:acme/billing:DEPLOY_TOKEN was last published from op://Private/billing deploy token/password`,
    );
    expect(swapped.stderr.text).toContain("Stopped before reading the value");
    expect(disk.contents.get(STATE)).toBe(before);

    const approved = publisher(disk, "/work/billing", true);
    expect(await cli(["publish", "DEPLOY_TOKEN"], approved.deps)).toBe(0);
    expect(approved.writes()).toHaveLength(1);
    const [saved] = (await loadState(disk.files, STATE)).receipts;
    expect(saved?.source).toEqual({
      kind: "1password",
      account: "my.1password.com",
      vault: "Private",
      item: "cloudflare admin token",
      section: null,
      field: "password",
    });
    expect(leaks(...disk.contents.values(), swapped.stderr.text, approved.stderr.text)).toBe(false);
  });

  test("pointing a key at another field of the same item needs approval, and the receipt records it", async () => {
    const at = (field: string) =>
      deployMap("billing deploy token").replace("/password", `/${field}`);
    const disk = memoryFiles({ "/work/billing/keypin.toml": at("password") });
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);

    disk.contents.set("/work/billing/keypin.toml", at("Password"));
    const same = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], same.deps)).toBe(0);
    expect(same.writes()).toEqual([]);

    disk.contents.set("/work/billing/keypin.toml", at("live/credential"));
    const moved = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], moved.deps)).toBe(NEEDS_APPROVAL);
    expect(moved.writes()).toEqual([]);
    expect(moved.stderr.text).toContain(
      "and now from op://Private/billing deploy token/live/credential",
    );

    const approved = publisher(disk, "/work/billing", true);
    expect(await cli(["publish", "DEPLOY_TOKEN"], approved.deps)).toBe(0);
    const [saved] = (await loadState(disk.files, STATE)).receipts;
    expect(saved?.source).toMatchObject({ section: "live", field: "credential" });
  });

  test("a field name that is one field's ID and another's title publishes neither, in any case", async () => {
    const stored: FullItem = {
      id: "item-1",
      title: "billing deploy token",
      category: "Password",
      vaultId: "vault-1",
      fields: [
        { id: "password", title: "old password", fieldType: "Concealed", value: ORDINARY },
        { id: "custom-field", title: "Password", fieldType: "Concealed", value: ADMIN },
      ],
      sections: [],
      notes: "",
      tags: [],
      websites: [],
      version: 1,
      files: [],
      createdAt: new Date("2026-11-01T00:00:00Z"),
      updatedAt: new Date("2026-11-09T12:00:00Z"),
    };
    const backend = onePasswordBackend(async () => ({
      vaults: { list: async () => [{ id: "vault-1", title: "Private" }] },
      items: {
        list: async () => [{ id: stored.id, title: stored.title, tags: [], updatedAt: new Date() }],
        get: async () => stored,
        create: async () => stored,
        put: async () => stored,
      },
    }));
    const disk = memoryFiles({ "/work/billing/keypin.toml": deployMap("billing deploy token") });
    for (const field of ["password", "Password"]) {
      disk.contents.set(
        "/work/billing/keypin.toml",
        deployMap("billing deploy token").replace("/password", `/${field}`),
      );
      const destinations = fakeDestinations();
      const run = fakeDeps({
        disk,
        backend,
        deps: {
          cwd: "/work/billing",
          destination: destinations.build,
          isTerminal: true,
          ask: async () => "yes",
        },
      });
      expect(await cli(["publish", "DEPLOY_TOKEN"], run.deps)).toBe(1);
      expect(run.stderr.text).toContain(`2 fields are named "${field}"`);
      expect(destinations.log.filter((l) => l.startsWith("write"))).toEqual([]);
    }
    expect(disk.contents.get(STATE)).toBeUndefined();
  });

  test("two keys writing the same repo secret are rejected before anything is read", async () => {
    const map = `${VAULTS}\n[keys.API_TOKEN]\nprod = { from = "op://Private/billing deploy token/password", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n[keys.api_token]\nprod = { from = "op://Private/cloudflare admin token/password", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n`;
    const run = publisher(memoryFiles({ "/work/billing/keypin.toml": map }), "/work/billing", true);
    expect(await cli(["publish", "API_TOKEN"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `key "api_token" prod publish[0]: writes the same destination secret as key "API_TOKEN" prod publish[0]`,
    );
    expect(run.writes()).toEqual([]);
  });

  test("a key's dev and prod writing the same secret are rejected", async () => {
    const map = `${VAULTS}\n[keys.DEPLOY_TOKEN]\ndev = { from = "op://Private/cloudflare admin token/password", publish = [{ to = "github-actions", repo = "acme/billing" }] }\nprod = { from = "op://Private/billing deploy token/password", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n`;
    const run = publisher(memoryFiles({ "/work/billing/keypin.toml": map }), "/work/billing", true);
    expect(await cli(["publish", "DEPLOY_TOKEN"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `key "DEPLOY_TOKEN" prod publish[0]: writes the same destination secret as key "DEPLOY_TOKEN" dev publish[0]`,
    );
    expect(run.writes()).toEqual([]);
  });

  test("the same key ID in another project, from another item, needs approval for the first project's secret", async () => {
    const disk = memoryFiles({
      "/work/billing/keypin.toml": deployMap("billing deploy token"),
      "/work/web/keypin.toml": deployMap("cloudflare admin token"),
    });
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);
    const other = publisher(disk, "/work/web", false);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], other.deps)).toBe(NEEDS_APPROVAL);
    expect(other.stderr.text).toContain("needs approval");
    expect(other.writes()).toEqual([]);
  });

  test("another project writing the same GitHub secret in another case makes the next write need approval", async () => {
    const named = (name: string, item: string) =>
      `${VAULTS}\n[keys.${name}]\nprod = { from = "op://Private/${item}/password", publish = [{ to = "github-actions", repo = "acme/billing" }] }\n`;
    const disk = memoryFiles({
      "/work/billing/keypin.toml": named("TOKEN", "billing deploy token"),
      "/work/web/keypin.toml": named("token", "cloudflare admin token"),
    });
    expect(await cli(["publish", "TOKEN"], publisher(disk, "/work/billing", true).deps)).toBe(0);
    expect(await cli(["publish", "token"], publisher(disk, "/work/web", true).deps)).toBe(0);
    expect((await loadState(disk.files, STATE)).receipts).toHaveLength(1);

    const again = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "TOKEN", "--yes"], again.deps)).toBe(NEEDS_APPROVAL);
    expect(again.stderr.text).toContain(
      "was last published from op://Private/cloudflare admin token/password",
    );
    expect(again.writes()).toEqual([]);
  });

  test("a state file from version 1 loads, and each destination needs approval once", async () => {
    const disk = memoryFiles({ "/work/billing/keypin.toml": deployMap("billing deploy token") });
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);
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
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], unattended.deps)).toBe(NEEDS_APPROVAL);
    expect(unattended.stderr.text).toContain("an item its receipt doesn't record");
    expect(unattended.writes()).toEqual([]);

    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);
    const rerun = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], rerun.deps)).toBe(0);
    expect(rerun.stderr.text).toContain("receipt already has this generation");
    expect(rerun.writes()).toEqual([]);
  });
});

function withoutSource(receipt: Receipt): Omit<Receipt, "source" | "mapFile"> {
  const { keyId, environment, destinationId, generation, account, at, evidence } = receipt;
  return { keyId, environment, destinationId, generation, account, at, evidence };
}

describe("two projects that map the same variable and environment", () => {
  const VAULTS = `[1password]\naccount = "my.1password.com"\n`;
  const projectMap = (project: string) =>
    `${VAULTS}\n[keys.API_TOKEN]\nprod = { from = "op://Private/${project} api token/password", publish = [\n  { to = "github-actions", repo = "acme/${project}" },\n  { to = "github-actions", repo = "acme/${project}-ops" },\n] }\n`;

  function publisher(
    disk: ReturnType<typeof memoryFiles>,
    project: string,
    options: FakeDestinationOptions = {},
  ) {
    const destinations = fakeDestinations(options);
    const fake = fakeDeps({
      disk,
      backend: fakeVault({
        values: { "billing api token": `${SENTINEL}-billing`, "web api token": `${SENTINEL}-web` },
      }).vault,
      deps: {
        cwd: `/work/${project}`,
        destination: destinations.build,
        isTerminal: true,
        ask: async () => "yes",
      },
    });
    return { ...fake, log: destinations.log };
  }

  test("keep their own unfinished operations and removed destinations apart", async () => {
    const disk = memoryFiles({
      "/work/billing/keypin.toml": projectMap("billing"),
      "/work/web/keypin.toml": projectMap("web"),
    });
    const billing = publisher(disk, "billing", { failWrite: ["github-actions:acme/billing-ops"] });
    expect(await cli(["publish", "API_TOKEN"], billing.deps)).toBe(1);
    const [left] = (await loadState(disk.files, STATE)).operations;
    expect(left).toMatchObject({
      mapFile: "/work/billing/keypin.toml",
      done: ["github-actions:acme/billing:API_TOKEN"],
    });

    const web = publisher(disk, "web");
    expect(await cli(["publish", "API_TOKEN"], web.deps)).toBe(0);
    expect(web.stderr.text).not.toContain("didn't finish");
    expect(web.stderr.text).not.toContain("not in the map any more");
    const state = await loadState(disk.files, STATE);
    expect(state.operations.map((o) => o.id)).toEqual([left?.id]);
    expect(state.receipts.map((r) => [r.destinationId, r.mapFile])).toEqual([
      ["github-actions:acme/billing:API_TOKEN", "/work/billing/keypin.toml"],
      ["github-actions:acme/web:API_TOKEN", "/work/web/keypin.toml"],
      ["github-actions:acme/web-ops:API_TOKEN", "/work/web/keypin.toml"],
    ]);

    const again = publisher(disk, "billing");
    expect(await cli(["publish", "API_TOKEN"], again.deps)).toBe(0);
    expect(again.stderr.text).toContain("An earlier publish");
    expect(again.stderr.text).toContain("wrote 1 of 2 (github-actions:acme/billing:API_TOKEN)");
    expect(again.stderr.text).not.toContain("not in the map any more");
    expect((await loadState(disk.files, STATE)).operations).toEqual([]);
  });
});

const ALL_MAP = `${BILLING_MAP}
[keys.OTHER_KEY]
prod = { from = "op://Private/billing other key/password", publish = [
  { to = "github-actions", repo = "acme/other" },
] }

[keys.DEV_ONLY]
dev = "op://Private/billing dev only/password"
`;

const OTHER_PLACE = "github-actions:acme/other";
const OTHER = `${OTHER_PLACE}:OTHER_KEY`;

function setupAll(
  options: FakeDestinationOptions & {
    terminal?: string;
    disk?: ReturnType<typeof memoryFiles>;
    suffix?: string;
  } = {},
) {
  const disk = options.disk ?? memoryFiles({ "/work/billing/keypin.toml": ALL_MAP });
  const suffix = options.suffix ?? "";
  const vault = fakeVault({
    values: {
      "billing stripe api key": `${SENTINEL}${suffix}`,
      "billing other key": `${SENTINEL}-other${suffix}`,
    },
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
  const writes = () => destinations.log.filter((l) => l.startsWith("write"));
  return {
    ...fake,
    disk,
    calls: vault.calls,
    log: destinations.log,
    asked,
    state,
    everything,
    writes,
  };
}

describe("keypin publish --all", () => {
  test("several keys get one combined plan and one approval, in map order", async () => {
    const run = setupAll({ terminal: "yes" });
    expect(await cli(["publish", "--all"], run.deps)).toBe(0);
    expect(run.asked).toEqual(["Type yes to write (this plan needs approval): "]);
    expect(run.calls).toEqual(["read billing stripe api key", "read billing other key"]);
    expect(run.writes()).toEqual([
      `write ${WORKER_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
      `write ${GITHUB_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
      `write ${OTHER_PLACE} OTHER_KEY (${SENTINEL.length + 6} chars)`,
    ]);
    const text = run.stderr.text;
    const firstWrite = text.indexOf("Published STRIPE_API_KEY");
    expect(text.indexOf("Plan for STRIPE_API_KEY, generation")).toBeLessThan(
      text.indexOf("Plan for OTHER_KEY, generation"),
    );
    expect(text.indexOf("Plan for OTHER_KEY, generation")).toBeLessThan(firstWrite);
    expect(text).toContain("Not published, no prod destinations: DEV_ONLY");
    expect(text).toContain("Published OTHER_KEY (prod) to 1 destination(s).");
    const state = await run.state();
    expect(state.receipts.map((r) => [r.keyId, r.destinationId])).toEqual([
      ["STRIPE_API_KEY", WORKER],
      ["STRIPE_API_KEY", GITHUB],
      ["OTHER_KEY", OTHER],
    ]);
    expect(state.operations).toEqual([]);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("a failed account check for any key stops before reading anything", async () => {
    const run = setupAll({ terminal: "yes", badAccount: [OTHER_PLACE] });
    expect(await cli(["publish", "--all"], run.deps)).toBe(1);
    expect(run.log).toEqual([
      `check ${WORKER_PLACE}`,
      `check ${GITHUB_PLACE}`,
      `check ${OTHER_PLACE}`,
    ]);
    expect(run.calls).toEqual([]);
    expect(run.asked).toEqual([]);
    expect(run.stderr.text).toContain(`FAILED ${OTHER} (account acme)`);
    expect(run.stderr.text).toContain("Nothing was read and nothing was written");
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("without a terminal, it lists every approval and the rerun command, and reads nothing, exit 3", async () => {
    const run = setupAll();
    expect(await cli(["publish", "--all", "--env", "prod"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.calls).toEqual([]);
    expect(run.stderr.text).not.toContain("keypin: reading");
    expect(run.stderr.text).toContain(
      `Needs approval:\n  first write to ${WORKER} (account 11111111111111111111111111111111)\n  first write to ${GITHUB} (account acme)\n  first write to ${OTHER} (account acme)\n`,
    );
    expect(run.stderr.text).toContain("Stopped before reading any value");
    expect(run.stderr.text).toContain(
      `To approve, run this in a terminal:\n  cd /work/billing && /opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts publish --all --env prod\n`,
    );
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("--plan shows every key's plan and approvals without a terminal, and writes nothing", async () => {
    const run = setupAll();
    const before = new Map(run.disk.contents);
    expect(await cli(["publish", "--all", "--plan"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.calls).toEqual(["read billing stripe api key", "read billing other key"]);
    expect(run.writes()).toEqual([]);
    expect(run.disk.contents).toEqual(before);
    expect(run.stderr.text).toContain("Plan for STRIPE_API_KEY, generation");
    expect(run.stderr.text).toContain("Plan for OTHER_KEY, generation");
    expect(run.stderr.text).toContain(`    needs approval: first write to ${OTHER} (account acme)`);
    expect(run.stderr.text).toContain("main.ts publish --all\n");
    expect(leaks(...run.everything())).toBe(false);
  });

  test("--yes is refused when any key's step needs approval, and accepted when none does", async () => {
    const first = setupAll({ terminal: "yes" });
    await cli(["publish", "--all"], first.deps);
    first.disk.contents.set(
      "/work/billing/keypin.toml",
      ALL_MAP.replace(
        'repo = "acme/other" }',
        'repo = "acme/other" }, { to = "github-actions", repo = "acme/more" }',
      ),
    );
    const refused = setupAll({ disk: first.disk, suffix: "-next" });
    expect(await cli(["publish", "--all", "--yes"], refused.deps)).toBe(NEEDS_APPROVAL);
    expect(refused.calls).toEqual([]);
    expect(refused.stderr.text).toContain("--yes can't give it");
    expect(refused.stderr.text).toContain("first write to github-actions:acme/more:OTHER_KEY");

    const asked = setupAll({ disk: first.disk, suffix: "-next", terminal: "no" });
    expect(await cli(["publish", "--all", "--yes"], asked.deps)).toBe(NEEDS_APPROVAL);
    expect(asked.asked).toEqual(["Type yes to write (this plan needs approval): "]);
    expect(asked.writes()).toEqual([]);

    first.disk.contents.set("/work/billing/keypin.toml", ALL_MAP);
    const routine = setupAll({ disk: first.disk, suffix: "-next" });
    expect(await cli(["publish", "--all", "--yes"], routine.deps)).toBe(0);
    expect(routine.asked).toEqual([]);
    expect(routine.writes()).toHaveLength(3);
    expect(routine.stderr.text).not.toContain("needs approval");
    expect(leaks(...routine.everything())).toBe(false);
  });

  test("a failed write stops, keeps the receipts so far, and names the keys left", async () => {
    const run = setupAll({ terminal: "yes", failWrite: [GITHUB_PLACE] });
    expect(await cli(["publish", "--all"], run.deps)).toBe(1);
    expect(run.writes()).toEqual([
      `write ${WORKER_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
    ]);
    expect(run.stderr.text).toContain("Not finished: STRIPE_API_KEY, OTHER_KEY.");
    expect(run.stderr.text).toContain("Finished writes keep their receipts");
    const state = await run.state();
    expect(state.receipts.map((r) => r.destinationId)).toEqual([WORKER]);
    expect(state.operations).toMatchObject([{ keyId: "STRIPE_API_KEY", done: [WORKER] }]);

    const again = setupAll({ terminal: "yes", disk: run.disk });
    expect(await cli(["publish", "--all"], again.deps)).toBe(0);
    expect(again.writes()).toEqual([
      `write ${GITHUB_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
      `write ${OTHER_PLACE} OTHER_KEY (${SENTINEL.length + 6} chars)`,
    ]);
    const after = await again.state();
    expect(after.receipts.map((r) => r.destinationId)).toEqual([WORKER, GITHUB, OTHER]);
    expect(after.operations).toEqual([]);
    expect(leaks(...again.everything())).toBe(false);
  });

  test("a failure in a later key keeps every earlier key's receipts", async () => {
    const run = setupAll({ terminal: "yes", failWrite: [OTHER_PLACE] });
    expect(await cli(["publish", "--all"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("Published STRIPE_API_KEY (prod) to 2 destination(s).");
    expect(run.stderr.text).toContain("Not finished: OTHER_KEY.");
    const state = await run.state();
    expect(state.receipts.map((r) => r.destinationId)).toEqual([WORKER, GITHUB]);
  });

  test("a variable and --all together are a usage error", async () => {
    const run = setupAll({ terminal: "yes" });
    expect(await cli(["publish", "STRIPE_API_KEY", "--all"], run.deps)).toBe(2);
    expect(run.stderr.text).toContain("a variable name or --all, not both");
    expect(run.log).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  test("an environment with no destinations anywhere publishes nothing", async () => {
    const run = setupAll({ terminal: "yes" });
    expect(await cli(["publish", "--all", "--env", "dev"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("No key in /work/billing/keypin.toml has dev destinations");
    expect(run.log).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  test("when every key is up to date, nothing is written and nothing is asked", async () => {
    const first = setupAll({ terminal: "yes" });
    await cli(["publish", "--all"], first.deps);
    const saved = first.disk.contents.get(STATE);
    const again = setupAll({ disk: first.disk });
    expect(await cli(["publish", "--all"], again.deps)).toBe(0);
    expect(again.writes()).toEqual([]);
    expect(again.stderr.text).toContain("Nothing to write");
    expect(again.disk.contents.get(STATE)).toBe(saved);
  });
});
