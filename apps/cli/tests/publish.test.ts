import { assert, describe, expect, test } from "vite-plus/test";
import {
  generationOf,
  loadState,
  type PublishTarget,
  type Receipt,
  recordReceipt,
  saveState,
  Secret,
} from "@keypin/core";
import { GitHubSecretDestination } from "@keypin/connectors/github";
import { type FullItem, onePasswordBackend } from "@keypin/connectors/onepassword";
import { cli } from "../src/cli";
import type { Deps, Publisher } from "../src/deps";
import { NEEDS_APPROVAL, rerun } from "../src/approval";
import { selfFor } from "../src/self";
import { destinations, vaults } from "../src/start";
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
import { changes, recording } from "./recording";

interface Recordable {
  deps: Deps;
  stdout: { text: string };
  stderr: { text: string };
  disk: ReturnType<typeof memoryFiles>;
  calls: string[];
  log: string[];
  asked: string[];
}

async function record(
  name: string,
  args: string[],
  run: Recordable,
  terminal?: string,
  given: Record<string, unknown> = {},
) {
  const before = new Map(run.disk.contents);
  const exit = await cli(args, run.deps);
  await expect(
    recording({
      args,
      exit,
      stdout: run.stdout.text,
      stderr: run.stderr.text,
      files: Object.fromEntries(before),
      given: { terminal: terminal ?? "none", ...given },
      calls: { vault: run.calls, destination: run.log, asked: run.asked },
      wrote: changes(before, run.disk.contents),
    }),
  ).toMatchFileSnapshot(`./recordings/publish/${name}.txt`);
  return exit;
}

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
  const disk = options.disk ?? memoryFiles({ "/work/billing/secretspec.toml": BILLING_MAP });
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
  const state = () => loadState(disk.files, STATE, vaults);
  const everything = () => [fake.stdout.text, fake.stderr.text, ...disk.contents.values()];
  return {
    ...fake,
    disk,
    calls: vault.calls,
    log: destinations.log,
    delivered: destinations.delivered,
    asked,
    state,
    everything,
  };
}

describe("keypin publish", () => {
  test("a registry keypin can't write is a warning; publish still runs", async () => {
    const run = setup({ terminal: "yes" });
    const { files } = run.disk;
    const write = files.write.bind(files);
    files.write = async (path, text) => {
      if (path.startsWith("/home/me/.config/keypin/")) throw new Error("read-only file system");
      return write(path, text);
    };
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
    expect(run.delivered(SENTINEL).length).toBeGreaterThan(0);
    expect(run.stderr.text).toContain(
      "keypin status can't list /work/billing: read-only file system",
    );
  });

  test("a state file keypin can't save stops publish before any destination changes", async () => {
    const run = setup({ terminal: "yes" });
    const { files } = run.disk;
    const write = files.write.bind(files);
    files.write = async (path, text) => {
      if (path.startsWith(STATE)) throw new Error("ENOSPC: no space left on device");
      return write(path, text);
    };
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(
      run.log.filter((l) => l.startsWith("write")),
      "no destination was written",
    ).toEqual([]);
    expect(run.delivered(SENTINEL)).toEqual([]);
    expect(run.stderr.text).toContain("keypin publish: ENOSPC: no space left on device");
  });

  test("a first publish without a terminal stops before reading the value, exit 3", async () => {
    const run = setup();
    expect(await record("first-without-terminal", ["publish", "STRIPE_API_KEY"], run)).toBe(
      NEEDS_APPROVAL,
    );
    expect(run.calls).toEqual([]);
    expect(run.disk.contents.has(STATE)).toBe(false);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("it prints the exact command to approve in a terminal: the folder and every argument", async () => {
    const run = setup();
    const fake = {
      ...run.deps,
      cwd: "/work/billing/src",
      self: {
        folder: "/work/billing/src",
        command: ["/opt/bun 1.4/bun", "--no-env-file", "/home/me/keypin/apps/cli/src/main.ts"],
      },
    };
    expect(await cli(["publish", "STRIPE_API_KEY", "--profile", "prod", "--yes"], fake)).toBe(
      NEEDS_APPROVAL,
    );
    expect(run.stderr.text).toContain(
      `To approve, run this in a terminal:\n  cd /work/billing/src && '/opt/bun 1.4/bun' --no-env-file /home/me/keypin/apps/cli/src/main.ts publish STRIPE_API_KEY --profile prod --yes\n`,
    );
    expect(run.stderr.text).not.toMatch(/(^|\s)keypin publish/m);
    expect(run.calls).toEqual([]);
  });

  test("when the keypin on PATH is this keypin, the command to approve is keypin itself", async () => {
    const run = setup();
    const fake = { ...run.deps, self: { folder: "/tmp/billing", command: ["keypin"] } };
    expect(await cli(["publish", "STRIPE_API_KEY", "--plan"], fake)).toBe(NEEDS_APPROVAL);
    expect(run.stderr.text).toContain(
      "To approve, run this in a terminal:\n  cd /tmp/billing && keypin publish STRIPE_API_KEY\n",
    );
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
    await record("declined", ["publish", "STRIPE_API_KEY"], run, "no");
    expect(run.stderr.text.indexOf("STRIPE_API_KEY prod  from op://")).toBeLessThan(
      run.stderr.text.indexOf("Read 1 value"),
    );
  });

  test("the approval command drops --plan", () => {
    const { deps } = setup();
    expect(rerun(deps, "publish", ["API_TOKEN", "--plan", "--yes"])).toContain(
      "main.ts publish API_TOKEN --yes",
    );
  });

  test("a confirmed first publish writes every destination and saves receipts", async () => {
    const run = setup({ terminal: "yes" });
    expect(await record("confirmed-first", ["publish", "STRIPE_API_KEY"], run, "yes")).toBe(0);
    expect(run.delivered(SENTINEL), "every destination got the vault's value").toEqual([
      `${WORKER_PLACE} STRIPE_API_KEY`,
      `${GITHUB_PLACE} STRIPE_API_KEY`,
    ]);
    const state = await run.state();
    const generation = await generationOf(new Secret(SENTINEL));
    expect(state.receipts.every((r) => r.generation === generation)).toBe(true);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("moving a key from the repo to a GitHub environment is a first write, and the repo secret is left", async () => {
    const first = setup({ terminal: "yes" });
    expect(await cli(["publish", "STRIPE_API_KEY"], first.deps)).toBe(0);
    const moved = BILLING_MAP.replace(
      '{ to = "github-actions", repo = "acme/billing" }',
      '{ to = "github-actions", repo = "acme/billing", environment = "production" }',
    );
    first.disk.contents.set("/work/billing/secretspec.toml", moved);
    const environment = `${GITHUB_PLACE}/environments/production`;

    const again = setup({ terminal: "yes", disk: first.disk });
    expect(await cli(["publish", "STRIPE_API_KEY"], again.deps)).toBe(0);
    expect(again.asked).toEqual(["Write 1 secret? [y/N] "]);
    expect(again.stderr.text).toMatch(
      /\+ GitHub {6}acme\/billing environment production {2}first write +needs approval/,
    );
    expect(again.stderr.text).toContain(`- ${GITHUB}: not in secretspec.toml any more`);
    expect(again.log.filter((l) => l.startsWith("write"))).toEqual([
      `write ${environment} STRIPE_API_KEY (${SENTINEL.length} chars)`,
    ]);
    expect((await again.state()).receipts.map((r) => r.destinationId)).toEqual([
      WORKER,
      GITHUB,
      `${environment}:STRIPE_API_KEY`,
    ]);
  });

  test("anything but y or yes on the terminal writes nothing", async () => {
    for (const answer of ["", "n", "no", "yess", "ok"]) {
      const run = setup({ terminal: answer });
      expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(NEEDS_APPROVAL);
      expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
      expect(run.disk.contents.has(STATE)).toBe(false);
    }
  });

  test("y, yes and Y each confirm", async () => {
    for (const answer of ["y", "Y", " yes ", "YES"]) {
      const run = setup({ terminal: answer });
      expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(0);
      expect(run.asked).toEqual(["Write 2 secrets? [y/N] "]);
      expect(run.log.filter((l) => l.startsWith("write"))).toHaveLength(2);
    }
  });

  test("a failure at the second destination keeps the first receipt, and the rerun skips the first", async () => {
    const first = setup({ terminal: "yes", failWrite: [GITHUB_PLACE] });
    expect(await cli(["publish", "STRIPE_API_KEY"], first.deps)).toBe(1);
    const state = await first.state();
    expect(state.receipts.map((r) => r.destinationId)).toEqual([WORKER]);
    expect(leaks(...first.everything())).toBe(false);

    const again = setup({ terminal: "yes", disk: first.disk });
    expect(await cli(["publish", "STRIPE_API_KEY"], again.deps)).toBe(0);
    expect(again.stderr.text).toContain("= Cloudflare  billing-worker  already has this value");
    expect(again.log.filter((l) => l.startsWith("write"))).toEqual([
      `write ${GITHUB_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
    ]);
    const after = await again.state();
    expect(after.receipts).toHaveLength(2);
    expect(leaks(...again.everything())).toBe(false);
  });

  test("a failed account check reads nothing and writes nothing", async () => {
    const run = setup({ terminal: "yes", badAccount: [GITHUB_PLACE] });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.log).toEqual([`check ${WORKER_PLACE}`, `check ${GITHUB_PLACE}`]);
    expect(run.asked).toEqual([]);
    expect(run.stderr.text).toContain("FAILED GitHub      acme/billing    as acme, pinned acme");
    expect(run.stderr.text).toContain("    the login can't reach acme");
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
    expect(again.stderr.text).toContain(
      "Nothing to write: the receipts on this machine show every destination already got this generation.",
    );
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
    expect(run.asked).toEqual(["Write 2 secrets? [y/N] "]);
    expect(run.log.some((l) => l.startsWith("write"))).toBe(false);
  });

  test("--yes is accepted when no step needs approval", async () => {
    const first = setup({ terminal: "yes" });
    await cli(["publish", "STRIPE_API_KEY"], first.deps);
    const next = setup({ disk: first.disk, value: `${SENTINEL}-next` });
    expect(await cli(["publish", "STRIPE_API_KEY", "--yes"], next.deps)).toBe(0);
    expect(next.log.filter((l) => l.startsWith("write"))).toHaveLength(2);
    expect(next.stderr.text).toContain("new value");
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
    expect(await record("plan", ["publish", "STRIPE_API_KEY", "--plan"], run)).toBe(NEEDS_APPROVAL);
    expect(run.disk.contents).toEqual(before);
    const generation = await generationOf(new Secret(SENTINEL));
    expect(run.stderr.text).toContain(`Plan  generation ${generation}`);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("--plan run from npx's cache prints npx with the running version", async () => {
    const run = setup();
    const binary = "/home/me/.npm/_npx/9bc54a/node_modules/@keypin/cli-darwin-arm64/bin/keypin";
    run.deps.self = selfFor({
      full: [binary],
      running: [binary],
      cwd: "/work/billing",
      version: "0.39.0",
      env: { PATH: "/home/me/.npm/_npx/9bc54a/node_modules/.bin:/usr/bin" },
      which: () => null,
      real: (path) => path,
      launches: () => null,
    });
    const args = ["publish", "STRIPE_API_KEY", "--plan"];
    const given = { running: binary, version: "0.39.0" };
    expect(await record("plan-from-npx", args, run, undefined, given)).toBe(NEEDS_APPROVAL);
    expect(run.stderr.text).toContain(
      "cd /work/billing && npx keypin@0.39.0 publish STRIPE_API_KEY\n",
    );
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
    expect(next.stderr.text).toContain("  ~ GitHub      acme/billing    new value");
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
      "/work/billing/secretspec.toml",
      BILLING_MAP.replace(/\n\s*\{ to = "github-actions", repo = "acme\/billing" \},/, ""),
    );
    const next = setup({ disk: first.disk });
    expect(await cli(["publish", "STRIPE_API_KEY"], next.deps)).toBe(0);
    expect(next.stderr.text).toContain(`- ${GITHUB}: not in secretspec.toml any more`);
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
    expect(await cli(["publish", "STRIPE_API_KEY", "--profile", "staging"], run.deps)).toBe(2);
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
    const disk = memoryFiles({ "/work/billing/secretspec.toml": TWO_KEYS_MAP });
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
    const state = await loadState(disk.files, STATE, vaults);
    expect(state.receipts.map((r) => r.keyId).toSorted()).toEqual([
      "OTHER_KEY",
      "STRIPE_API_KEY",
      "STRIPE_API_KEY",
    ]);
  });

  test("a held lock names its process: still running, gone, or none recorded", async () => {
    for (const [holder, says] of [
      [{ file: `${STATE}.lock`, pid: 4242, running: true }, "another keypin (process 4242) holds"],
      [
        { file: `${STATE}.lock`, pid: 4242, running: false },
        "was left by process 4242, which isn't running any more. Delete that file",
      ],
      [
        { file: `${STATE}.lock`, pid: null, running: null },
        "exists but names no process. If no keypin is running, delete that file",
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
      "/work/billing/secretspec.toml",
      BILLING_MAP.replaceAll("STRIPE_API_KEY", "STRIPE_KEY"),
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

  test("an organization repo: a teammate publishes as their own login, and another teammate's rerun skips", async () => {
    const disk = memoryFiles({ "/work/billing/secretspec.toml": ORG_MAP });
    const requests: string[] = [];
    let actingAs = "alice";
    const respond = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url.pathname}`);
      const reply =
        url.pathname === "/user"
          ? { status: 200, body: { login: actingAs } }
          : (ORG_ROUTES.get(`${method} ${url.pathname}`) ?? { status: 404, body: {} });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "x-oauth-scopes": "repo" },
      });
    };
    const fetch = Object.assign(respond, { preconnect: globalThis.fetch.preconnect });
    const logins: (string | null)[] = [];
    const github = (target: PublishTarget, publisher: Publisher) => {
      logins.push(publisher.githubLogin);
      assert(target.to === "github-actions" && target.repo !== undefined);
      return new GitHubSecretDestination({
        repo: target.repo,
        login: publisher.githubLogin,
        token: async () => "token",
        fetch,
      });
    };
    const deps = (terminal: boolean, configured: string | null) =>
      fakeDeps({
        disk,
        backend: fakeVault({ values: { "billing stripe api key": SENTINEL } }).vault,
        deps: {
          destination: github,
          isTerminal: terminal,
          ask: async () => "yes",
          git: async (_folder, args) =>
            args.join(" ") === "config --get github.account" && configured
              ? `${configured}\n`
              : null,
        },
      });
    const first = deps(true, "alice");
    expect(await cli(["publish", "STRIPE_API_KEY"], first.deps)).toBe(0);
    expect(first.stderr.text).toContain("ok     GitHub  acme/billing  as alice, account acme");
    const saved = await loadState(disk.files, STATE, vaults);
    expect(saved.receipts).toMatchObject([
      { account: { pinned: "acme", publisher: "alice", destinationAccount: "acme" } },
    ]);

    actingAs = "bob";
    const again = deps(false, null);
    requests.length = 0;
    expect(await cli(["publish", "STRIPE_API_KEY"], again.deps)).toBe(0);
    expect(again.stderr.text).toContain("as bob, account acme");
    expect(again.stderr.text).toContain("already has this value");
    expect(again.stderr.text).not.toContain("account changed");
    expect(requests.some((r) => r.startsWith("PUT"))).toBe(false);
    expect(logins).toEqual(["alice", null]);
  });

  test("a receipt from a 0.6 map that pinned a login asks once for approval", async () => {
    const disk = memoryFiles({ "/work/billing/secretspec.toml": ORG_MAP });
    const generation = await generationOf(new Secret(SENTINEL));
    const old: Receipt = {
      keyId: "STRIPE_API_KEY",
      environment: "prod",
      mapFile: "/work/billing/secretspec.toml",
      source: {
        kind: "1password",
        account: "my.1password.com",
        vault: "Private",
        item: "billing stripe api key",
        section: null,
        field: "password",
      },
      sourceIds: null,
      destinationId: "github-actions:acme/billing:STRIPE_API_KEY",
      generation,
      account: { pinned: "alice", publisher: "alice", destinationAccount: "acme" },
      at: "2026-11-01T00:00:00.000Z",
      evidence: {},
    };
    await saveState(
      disk.files,
      STATE,
      recordReceipt(await loadState(disk.files, STATE, vaults), old, destinations),
    );
    const run = setup({ disk });
    expect(await cli(["publish", "STRIPE_API_KEY"], run.deps)).toBe(NEEDS_APPROVAL);
    expect(run.stderr.text).toContain(
      "github-actions:acme/billing:STRIPE_API_KEY account changed from alice to acme",
    );
  });
});

const TWO_KEYS_MAP = `${BILLING_MAP}

[profiles.prod.OTHER_KEY]
description = "OTHER_KEY"
ref = { item = "billing other key", field = "password" }

[tool.keypin.prod.OTHER_KEY]
publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "billing-worker" }]
`;

const ORG_MAP = `
[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
STRIPE_API_KEY = { description = "STRIPE_API_KEY", ref = { item = "billing stripe api key", field = "password" } }

[tool.keypin.prod.STRIPE_API_KEY]
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

const ORG_ROUTES = new Map<string, { status: number; body: unknown }>([
  ["GET /user", { status: 200, body: { login: "alice" } }],
  [
    "GET /repos/acme/billing",
    { status: 200, body: { owner: { login: "acme" }, permissions: { admin: false, push: true } } },
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
  const VAULTS = `[project]\nname = "billing"\nrevision = "1.0"\n\n[providers]\nvault = "onepassword://my.1password.com@Private"\n\n[defaults]\nproviders = ["vault"]\n\n[profiles.dev]\n\n[profiles.prod]\n`;
  const deployMap = (item: string) =>
    `${VAULTS}\n\n[profiles.prod.DEPLOY_TOKEN]\ndescription = "DEPLOY_TOKEN"\nref = { item = "${item}", field = "password" }\n\n[tool.keypin.prod.DEPLOY_TOKEN]\npublish = [{ to = "github-actions", repo = "acme/billing" }]\n`;

  function publisher(
    disk: ReturnType<typeof memoryFiles>,
    cwd: string,
    terminal: boolean,
    ids: Record<string, string> = {},
  ) {
    const destinations = fakeDestinations();
    const vault = fakeVault({
      values: {
        "billing deploy token": ORDINARY,
        "billing deploy token v2": ORDINARY,
        "cloudflare admin token": ADMIN,
      },
      ids,
    });
    const fake = fakeDeps({
      disk,
      backend: vault.vault,
      deps: { cwd, destination: destinations.build, isTerminal: terminal, ask: async () => "yes" },
    });
    const writes = () => destinations.log.filter((l) => l.startsWith("write"));
    return { ...fake, writes, calls: vault.calls };
  }

  test("pointing a key at another item needs approval, and --yes without a terminal writes nothing", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": deployMap("billing deploy token"),
    });
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);
    const before = disk.contents.get(STATE);

    disk.contents.set("/work/billing/secretspec.toml", deployMap("cloudflare admin token"));
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
    const [saved] = (await loadState(disk.files, STATE, vaults)).receipts;
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

  test("a new item with the same title needs approval, and the receipt records the item's IDs", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": deployMap("billing deploy token"),
    });
    const first = { "billing deploy token": "item-1" };
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true, first).deps),
    ).toBe(0);
    const [saved] = (await loadState(disk.files, STATE, vaults)).receipts;
    expect(saved?.sourceIds).toEqual({ vault: "id-private", item: "item-1" });

    const same = publisher(disk, "/work/billing", false, first);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], same.deps)).toBe(0);
    expect(same.stderr.text).toContain("already has this value");
    expect(same.calls).toEqual(["ids billing deploy token", "read billing deploy token"]);

    const before = disk.contents.get(STATE);
    const replaced = { "billing deploy token": "item-2" };
    const unattended = publisher(disk, "/work/billing", false, replaced);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], unattended.deps)).toBe(NEEDS_APPROVAL);
    expect(unattended.writes()).toEqual([]);
    expect(unattended.calls).toEqual(["ids billing deploy token"]);
    expect(unattended.stderr.text).toContain("Stopped before reading the value");
    expect(unattended.stderr.text).toContain(
      "  github-actions:acme/billing:DEPLOY_TOKEN was last published from op://Private/billing deploy token/password (1Password account my.1password.com) (item item-1 in vault id-private), and now from op://Private/billing deploy token/password (1Password account my.1password.com) (item item-2 in vault id-private)",
    );
    expect(disk.contents.get(STATE)).toBe(before);

    const approved = publisher(disk, "/work/billing", true, replaced);
    expect(await cli(["publish", "DEPLOY_TOKEN"], approved.deps)).toBe(0);
    expect(approved.writes()).toHaveLength(1);
    const [now] = (await loadState(disk.files, STATE, vaults)).receipts;
    expect(now?.sourceIds).toEqual({ vault: "id-private", item: "item-2" });
    expect(leaks(...disk.contents.values(), unattended.stderr.text)).toBe(false);
  });

  test("a deleted item stops an unattended --yes at the ID lookup, before any read", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": deployMap("billing deploy token"),
    });
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);
    const before = disk.contents.get(STATE);
    disk.contents.set("/work/billing/secretspec.toml", deployMap("billing deploy token gone"));
    const gone = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], gone.deps)).toBe(1);
    expect(gone.calls).toEqual(["ids billing deploy token gone"]);
    expect(gone.writes()).toEqual([]);
    expect(gone.stderr.text).toContain('no item "billing deploy token gone"');
    expect(disk.contents.get(STATE)).toBe(before);
  });

  test("a renamed item that is still the same item stays routine", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": deployMap("billing deploy token"),
    });
    const ids = { "billing deploy token": "item-1", "billing deploy token v2": "item-1" };
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true, ids).deps),
    ).toBe(0);
    disk.contents.set("/work/billing/secretspec.toml", deployMap("billing deploy token v2"));
    const renamed = publisher(disk, "/work/billing", false, ids);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], renamed.deps)).toBe(0);
    expect(renamed.stderr.text).toContain("already has this value");
    expect(renamed.stderr.text).not.toContain("needs approval");
  });

  test("a receipt without item IDs compares the reference, as before", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": deployMap("billing deploy token"),
    });
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);
    const current = await loadState(disk.files, STATE, vaults);
    const v3 = JSON.stringify({
      version: 3,
      operations: [],
      receipts: current.receipts.map(({ sourceIds: _ids, ...r }) => r),
    });

    disk.contents.set(STATE, v3);
    const replaced = { "billing deploy token": "item-2" };
    const same = publisher(disk, "/work/billing", false, replaced);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], same.deps)).toBe(0);
    expect(same.stderr.text).toContain("already has this value");

    disk.contents.set(STATE, v3);
    disk.contents.set("/work/billing/secretspec.toml", deployMap("billing deploy token v2"));
    const renamed = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], renamed.deps)).toBe(NEEDS_APPROVAL);
    expect(renamed.stderr.text).toContain(
      "was last published from op://Private/billing deploy token/password",
    );
    expect(renamed.writes()).toEqual([]);
  });

  test("pointing a key at another field of the same item needs approval, and the receipt records it", async () => {
    const at = (field: string) =>
      deployMap("billing deploy token").replace('field = "password"', field);
    const disk = memoryFiles({ "/work/billing/secretspec.toml": at('field = "password"') });
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);

    disk.contents.set("/work/billing/secretspec.toml", at('field = "Password"'));
    const same = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], same.deps)).toBe(0);
    expect(same.writes()).toEqual([]);

    disk.contents.set(
      "/work/billing/secretspec.toml",
      at('section = "live", field = "credential"'),
    );
    const moved = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "DEPLOY_TOKEN", "--yes"], moved.deps)).toBe(NEEDS_APPROVAL);
    expect(moved.writes()).toEqual([]);
    expect(moved.stderr.text).toContain(
      "and now from op://Private/billing deploy token/live/credential",
    );

    const approved = publisher(disk, "/work/billing", true);
    expect(await cli(["publish", "DEPLOY_TOKEN"], approved.deps)).toBe(0);
    const [saved] = (await loadState(disk.files, STATE, vaults)).receipts;
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
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": deployMap("billing deploy token"),
    });
    for (const field of ["password", "Password"]) {
      disk.contents.set(
        "/work/billing/secretspec.toml",
        deployMap("billing deploy token").replace('field = "password"', `field = "${field}"`),
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
    const map = `${VAULTS}\n\n[profiles.prod.API_TOKEN]\ndescription = "API_TOKEN"\nref = { item = "billing deploy token", field = "password" }\n\n[profiles.prod.api_token]\ndescription = "api_token"\nref = { item = "cloudflare admin token", field = "password" }\n\n[tool.keypin.prod.API_TOKEN]\npublish = [{ to = "github-actions", repo = "acme/billing" }]\n\n[tool.keypin.prod.api_token]\npublish = [{ to = "github-actions", repo = "acme/billing" }]\n`;
    const run = publisher(
      memoryFiles({ "/work/billing/secretspec.toml": map }),
      "/work/billing",
      true,
    );
    expect(await cli(["publish", "API_TOKEN"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `[tool.keypin.prod.api_token] publish[0]: writes the same destination secret as [tool.keypin.prod.API_TOKEN] publish[0]`,
    );
    expect(run.writes()).toEqual([]);
  });

  test("a key's dev and prod writing the same secret are rejected", async () => {
    const map = `${VAULTS}\n\n[profiles.dev.DEPLOY_TOKEN]\ndescription = "DEPLOY_TOKEN"\nref = { item = "cloudflare admin token", field = "password" }\n\n[profiles.prod.DEPLOY_TOKEN]\ndescription = "DEPLOY_TOKEN"\nref = { item = "billing deploy token", field = "password" }\n\n[tool.keypin.dev.DEPLOY_TOKEN]\npublish = [{ to = "github-actions", repo = "acme/billing" }]\n\n[tool.keypin.prod.DEPLOY_TOKEN]\npublish = [{ to = "github-actions", repo = "acme/billing" }]\n`;
    const run = publisher(
      memoryFiles({ "/work/billing/secretspec.toml": map }),
      "/work/billing",
      true,
    );
    expect(await cli(["publish", "DEPLOY_TOKEN"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `[tool.keypin.prod.DEPLOY_TOKEN] publish[0]: writes the same destination secret as [tool.keypin.dev.DEPLOY_TOKEN] publish[0]`,
    );
    expect(run.writes()).toEqual([]);
  });

  test("the same key ID in another project, from another item, needs approval for the first project's secret", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": deployMap("billing deploy token"),
      "/work/web/secretspec.toml": deployMap("cloudflare admin token"),
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
      `${VAULTS}\n\n[profiles.prod.${name}]\ndescription = "${name}"\nref = { item = "${item}", field = "password" }\n\n[tool.keypin.prod.${name}]\npublish = [{ to = "github-actions", repo = "acme/billing" }]\n`;
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": named("TOKEN", "billing deploy token"),
      "/work/web/secretspec.toml": named("token", "cloudflare admin token"),
    });
    expect(await cli(["publish", "TOKEN"], publisher(disk, "/work/billing", true).deps)).toBe(0);
    expect(await cli(["publish", "token"], publisher(disk, "/work/web", true).deps)).toBe(0);
    expect((await loadState(disk.files, STATE, vaults)).receipts).toHaveLength(1);

    const again = publisher(disk, "/work/billing", false);
    expect(await cli(["publish", "TOKEN", "--yes"], again.deps)).toBe(NEEDS_APPROVAL);
    expect(again.stderr.text).toContain(
      "was last published from op://Private/cloudflare admin token/password",
    );
    expect(again.writes()).toEqual([]);
  });

  test("a state file from version 1 loads, and each destination needs approval once", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": deployMap("billing deploy token"),
    });
    expect(
      await cli(["publish", "DEPLOY_TOKEN"], publisher(disk, "/work/billing", true).deps),
    ).toBe(0);
    const current = await loadState(disk.files, STATE, vaults);
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
    expect(rerun.stderr.text).toContain("already has this value");
    expect(rerun.writes()).toEqual([]);
  });
});

function withoutSource(receipt: Receipt): Omit<Receipt, "source" | "sourceIds" | "mapFile"> {
  const { keyId, environment, destinationId, generation, account, at, evidence } = receipt;
  return { keyId, environment, destinationId, generation, account, at, evidence };
}

describe("two projects that map the same variable and environment", () => {
  const VAULTS = `[project]\nname = "billing"\nrevision = "1.0"\n\n[providers]\nvault = "onepassword://my.1password.com@Private"\n\n[defaults]\nproviders = ["vault"]\n\n[profiles.dev]\n\n[profiles.prod]\n`;
  const projectMap = (project: string) =>
    `${VAULTS}\n\n[profiles.prod.API_TOKEN]\ndescription = "API_TOKEN"\nref = { item = "${project} api token", field = "password" }\n\n[tool.keypin.prod.API_TOKEN]\npublish = [\n  { to = "github-actions", repo = "acme/${project}" },\n  { to = "github-actions", repo = "acme/${project}-ops" },\n]\n`;

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

  test("keep their own receipts and removed destinations apart", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": projectMap("billing"),
      "/work/web/secretspec.toml": projectMap("web"),
    });
    const billing = publisher(disk, "billing", { failWrite: ["github-actions:acme/billing-ops"] });
    expect(await cli(["publish", "API_TOKEN"], billing.deps)).toBe(1);

    const web = publisher(disk, "web");
    expect(await cli(["publish", "API_TOKEN"], web.deps)).toBe(0);
    expect(web.stderr.text).not.toContain("not in secretspec.toml any more");
    const state = await loadState(disk.files, STATE, vaults);
    expect(state.receipts.map((r) => [r.destinationId, r.mapFile])).toEqual([
      ["github-actions:acme/billing:API_TOKEN", "/work/billing/secretspec.toml"],
      ["github-actions:acme/web:API_TOKEN", "/work/web/secretspec.toml"],
      ["github-actions:acme/web-ops:API_TOKEN", "/work/web/secretspec.toml"],
    ]);

    const again = publisher(disk, "billing");
    expect(await cli(["publish", "API_TOKEN"], again.deps)).toBe(0);
    expect(again.log.filter((l) => l.startsWith("write"))).toEqual([
      expect.stringContaining("acme/billing-ops"),
    ]);
    expect(again.stderr.text).not.toContain("not in secretspec.toml any more");
  });
});

const ALL_MAP = `${BILLING_MAP}

[profiles.dev.DEV_ONLY]
description = "DEV_ONLY"
ref = { item = "billing dev only", field = "password" }

[profiles.prod.OTHER_KEY]
description = "OTHER_KEY"
ref = { item = "billing other key", field = "password" }

[tool.keypin.prod.OTHER_KEY]
publish = [{ to = "github-actions", repo = "acme/other" }]
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
  const disk = options.disk ?? memoryFiles({ "/work/billing/secretspec.toml": ALL_MAP });
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
  const state = () => loadState(disk.files, STATE, vaults);
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
    delivered: destinations.delivered,
  };
}

describe("keypin publish --all", () => {
  test("several keys get one combined plan and one approval, in map order", async () => {
    const run = setupAll({ terminal: "yes" });
    expect(await record("all-confirmed", ["publish", "--all"], run, "yes")).toBe(0);
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
    expect(run.stderr.text).toContain("FAILED GitHub      acme/other      as acme, pinned acme");
    expect(run.stderr.text).toContain("Nothing was read and nothing was written");
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("without a terminal, it lists every approval and the rerun command, and reads nothing, exit 3", async () => {
    const run = setupAll();
    expect(
      await record("all-without-terminal", ["publish", "--all", "--profile", "prod"], run),
    ).toBe(NEEDS_APPROVAL);
    expect(run.calls).toEqual([]);
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("--plan shows every key's plan and approvals without a terminal, and writes nothing", async () => {
    const run = setupAll();
    const before = new Map(run.disk.contents);
    expect(await record("all-plan", ["publish", "--all", "--plan"], run)).toBe(NEEDS_APPROVAL);
    expect(run.writes()).toEqual([]);
    expect(run.disk.contents).toEqual(before);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("--yes is refused when any key's step needs approval, and accepted when none does", async () => {
    const first = setupAll({ terminal: "yes" });
    await cli(["publish", "--all"], first.deps);
    first.disk.contents.set(
      "/work/billing/secretspec.toml",
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
    expect(asked.asked).toEqual(["Write 4 secrets? [y/N] "]);
    expect(asked.writes()).toEqual([]);

    first.disk.contents.set("/work/billing/secretspec.toml", ALL_MAP);
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
    expect(run.stderr.text).toContain("Finished writes keep their receipts");
    const state = await run.state();
    expect(state.receipts.map((r) => r.destinationId)).toEqual([WORKER]);

    const again = setupAll({ terminal: "yes", disk: run.disk });
    expect(await cli(["publish", "--all"], again.deps)).toBe(0);
    expect(again.writes()).toEqual([
      `write ${GITHUB_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
      `write ${OTHER_PLACE} OTHER_KEY (${SENTINEL.length + 6} chars)`,
    ]);
    const after = await again.state();
    expect(after.receipts.map((r) => r.destinationId)).toEqual([WORKER, GITHUB, OTHER]);
    expect(leaks(...again.everything())).toBe(false);
  });

  test("a failure in a later key keeps every earlier key's receipts", async () => {
    const run = setupAll({ terminal: "yes", failWrite: [OTHER_PLACE] });
    expect(await cli(["publish", "--all"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("Published STRIPE_API_KEY (prod) to 2 destinations.");
    const state = await run.state();
    expect(state.receipts.map((r) => r.destinationId)).toEqual([WORKER, GITHUB]);
  });

  test("several keys to one Worker go in one request, so it deploys once", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": ALL_MAP.replace(
        '{ to = "github-actions", repo = "acme/other" }]',
        '{ to = "github-actions", repo = "acme/other" }, { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "billing-worker" }]',
      ),
    });
    const run = setupAll({ terminal: "yes", disk });
    expect(await cli(["publish", "--all"], run.deps)).toBe(0);
    expect(run.writes()).toEqual([
      `write ${WORKER_PLACE} STRIPE_API_KEY OTHER_KEY in one request`,
      `write ${GITHUB_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
      `write ${OTHER_PLACE} OTHER_KEY (${SENTINEL.length + 6} chars)`,
    ]);
    expect(run.stderr.text).toContain("wrote STRIPE_API_KEY, OTHER_KEY in one version");
    expect(run.delivered(SENTINEL)).toContain(`${WORKER_PLACE} STRIPE_API_KEY`);
    expect(run.delivered(`${SENTINEL}-other`)).toContain(`${WORKER_PLACE} OTHER_KEY`);
    const state = await run.state();
    expect(state.receipts.map((r) => r.destinationId)).toEqual([
      WORKER,
      `${WORKER_PLACE}:OTHER_KEY`,
      GITHUB,
      OTHER,
    ]);
    expect(leaks(...run.everything())).toBe(false);
  });

  test("a later key's part of a Worker write keeps its receipt when an earlier write fails", async () => {
    const map = ALL_MAP.replace(
      '{ to = "github-actions", repo = "acme/other" }]',
      '{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "billing-worker" }]',
    );
    const first = setupAll({
      terminal: "yes",
      disk: memoryFiles({ "/work/billing/secretspec.toml": map }),
    });
    expect(await cli(["publish", "--all"], first.deps)).toBe(0);
    const before = await first.state();

    const run = setupAll({
      terminal: "yes",
      disk: first.disk,
      suffix: "-new",
      failWrite: [GITHUB_PLACE],
    });
    expect(await cli(["publish", "--all"], run.deps)).toBe(1);
    expect(run.writes()).toEqual([`write ${WORKER_PLACE} STRIPE_API_KEY OTHER_KEY in one request`]);
    const state = await run.state();
    const generation = (id: string, s = state) =>
      s.receipts.find((r) => r.destinationId === id)?.generation;
    const other = `${WORKER_PLACE}:OTHER_KEY`;
    expect(generation(other)).not.toBe(generation(other, before));
    expect(generation(WORKER)).not.toBe(generation(WORKER, before));
    expect(generation(GITHUB)).toBe(generation(GITHUB, before));

    const restored = setupAll({ disk: run.disk });
    expect(await cli(["publish", "OTHER_KEY", "--plan"], restored.deps)).toBe(3);
  });

  test("a rewrite to a new account with the same value stays unfinished when it fails", async () => {
    const first = setupAll({ terminal: "yes" });
    expect(await cli(["publish", "--all"], first.deps)).toBe(0);
    const moved = (await first.disk.files.read("/work/billing/secretspec.toml"))?.replaceAll(
      "11111111111111111111111111111111",
      "22222222222222222222222222222222",
    );
    assert(moved !== undefined && moved !== null);
    await first.disk.files.write("/work/billing/secretspec.toml", moved);
    const run = setupAll({
      terminal: "yes",
      disk: first.disk,
      failWrite: [WORKER_PLACE],
    });
    expect(await cli(["publish", "--all"], run.deps)).toBe(1);
    expect(run.stderr.text).not.toContain("Not finished");
  });

  test("same-named Workers in two accounts get separate writes", async () => {
    const disk = memoryFiles({
      "/work/billing/secretspec.toml": ALL_MAP.replace(
        '{ to = "github-actions", repo = "acme/other" }]',
        '{ to = "cloudflare-worker", account = "22222222222222222222222222222222", worker = "billing-worker" }]',
      ),
    });
    const run = setupAll({ terminal: "yes", disk });
    expect(await cli(["publish", "--all"], run.deps)).toBe(0);
    expect(run.writes()).toEqual([
      `write ${WORKER_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
      `write ${GITHUB_PLACE} STRIPE_API_KEY (${SENTINEL.length} chars)`,
      `write ${WORKER_PLACE} OTHER_KEY (${SENTINEL.length + 6} chars)`,
    ]);
    expect(run.stderr.text).not.toContain("in one version");
    const workers = (await run.state()).receipts.filter((r) =>
      r.destinationId.startsWith(WORKER_PLACE),
    );
    expect(workers.map((r) => [r.keyId, r.account.pinned])).toEqual([
      ["STRIPE_API_KEY", "1".repeat(32)],
      ["OTHER_KEY", "2".repeat(32)],
    ]);
    expect(workers[0]?.evidence).not.toEqual(workers[1]?.evidence);
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
    expect(await cli(["publish", "--all", "--profile", "dev"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      "No key in /work/billing/secretspec.toml has dev destinations",
    );
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
