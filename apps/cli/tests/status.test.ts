import { describe, expect, test, vi } from "vite-plus/test";
import { stripVTControlCharacters } from "node:util";
import { cli } from "../src/cli";
import type { Deps } from "../src/deps";

import {
  fakeDeps,
  fakeVault,
  memoryFiles,
  BILLING_MAP,
  parseJson,
  REGISTRY,
  registryWith,
  WEB_MAP,
  STATE,
  newSecretspec,
} from "./fakes";
import { changes, recording } from "./recording";

const TEMPLATE = newSecretspec("billing");

async function record(
  name: string,
  args: string[],
  run: ReturnType<typeof fakeDeps>,
  more: { given?: Record<string, unknown>; calls?: Record<string, readonly string[]> } = {},
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
      ...more,
      wrote: changes(before, run.disk.contents),
    }),
  ).toMatchFileSnapshot(`./recordings/status/${name}.txt`);
  return exit;
}

const METADATA = {
  "web dev session secret": { rotated: "2026-11-09" },
  "web prod session secret": { rotated: "2026-11-09" },
  "billing stripe api key": { rotated: "2026-10-23" },
};

function setup(options: { failing?: string[]; state?: string } = {}) {
  const files = memoryFiles({
    [REGISTRY]: registryWith("/work/billing", "/work/web"),
    "/work/billing/secretspec.toml": BILLING_MAP,
    "/work/web/secretspec.toml": WEB_MAP,
    ...(options.state ? { [STATE]: options.state } : {}),
  });
  const fake = fakeVault({ metadata: METADATA, failing: options.failing });
  return { ...fakeDeps({ disk: files, backend: fake.vault }), calls: fake.calls };
}

const sessionReceipt = {
  keyId: "SESSION_SECRET",
  environment: "prod",
  destinationId: "cloudflare-worker:web:SESSION_SECRET",
  generation: "0123456789abcdef",
  account: {
    pinned: "11111111111111111111111111111111",
    publisher: "me@example.com",
    destinationAccount: "11111111111111111111111111111111",
  },
  at: "2026-11-09T15:30:35Z",
  evidence: { versionId: "v1" },
};

describe("keypin status", () => {
  test("a fresh map lists every key, says what to publish, and exits 0", async () => {
    const run = setup();
    const given = { "rotated dates": METADATA };
    expect(await record("fresh-map", ["status"], run, { given, calls: { vault: run.calls } })).toBe(
      0,
    );
  });

  test("a receipt from state version 1, which records neither item nor project, is missing until the next publish", async () => {
    const state = JSON.stringify({ version: 1, operations: [], receipts: [sessionReceipt] });
    const { deps, stdout } = setup({ state });
    expect(await cli(["status"], deps)).toBe(1);
    expect(stdout.text).toContain(
      "SESSION_SECRET  prod  due in 180 days  · Cloudflare no receipt\n",
    );
    expect(stdout.text).toContain(
      "1 problem\n  web SESSION_SECRET (prod): cloudflare-worker:web:SESSION_SECRET's last receipt isn't from this project or this key's item",
    );
    expect(stdout.text.match(/not published yet/g)).toHaveLength(1);
  });

  test("shows a destination's last receipt", async () => {
    const state = JSON.stringify({
      version: 3,
      operations: [],
      receipts: [{ ...sessionReceipt, mapFile: "/work/web/secretspec.toml", source: null }],
    });
    const { deps, stdout } = setup({ state });
    expect(await cli(["status"], deps)).toBe(0);
    expect(stdout.text).toContain("SESSION_SECRET  prod  due in 180 days  ok Cloudflare\n");
    expect(stdout.text).not.toContain("problem");
    expect(stdout.text.match(/not published yet/g)).toHaveLength(1);
  });

  test("a destination added after the key was published is a problem", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/web"),
      "/work/web/secretspec.toml": WEB_MAP.replace(
        'worker = "web" }]',
        'worker = "web" }, { to = "github-actions", repo = "acme/web" }]',
      ),
      [STATE]: JSON.stringify({
        version: 3,
        operations: [],
        receipts: [{ ...sessionReceipt, mapFile: "/work/web/secretspec.toml", source: null }],
      }),
    });
    const { deps, stdout } = fakeDeps({
      disk: files,
      backend: fakeVault({ metadata: METADATA }).vault,
    });
    expect(await cli(["status"], deps)).toBe(1);
    expect(stdout.text).toContain(
      "SESSION_SECRET  prod  due in 180 days  ok Cloudflare  · GitHub no receipt\n",
    );
    expect(stdout.text).toContain(
      "1 problem\n  web SESSION_SECRET (prod): no receipt for github-actions:acme/web:SESSION_SECRET, though this project published this key before, so what it holds is unknown; keypin publish SESSION_SECRET writes it again\n",
    );
    expect(stdout.text).not.toContain("not published");
  });

  test("a failing metadata read is rotation-unreadable, never nothing due", async () => {
    const run = setup({ failing: ["billing stripe api key"] });
    const given = { "rotated dates": METADATA, unreadable: ["billing stripe api key"] };
    expect(await record("unreadable-date", ["status"], run, { given })).toBe(1);
    expect(run.stdout.text).toMatch(/STRIPE_API_KEY {2}prod {2}rotation unknown/);
  });

  test("a sign-in that fails for every key prints its error once", async () => {
    const { deps, stderr } = setup();
    deps.vault = () => ({
      ...fakeVault().vault,
      metadata: async () => {
        throw new Error('1Password account "my.1password.com": sign-in failed: no desktop app');
      },
    });
    expect(await cli(["status"], deps)).toBe(1);
    expect(stderr.text.match(/sign-in failed/g)).toHaveLength(1);
  });

  test("a key with no destinations has nothing to report", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/billing"),
      "/work/billing/secretspec.toml": BILLING_MAP.replace(/publish = \[[\s\S]*?\n\]\n/, ""),
    });
    const run = fakeDeps({ disk: files, backend: fakeVault({ metadata: METADATA }).vault });
    const given = { "rotated dates": METADATA };
    expect(await record("no-destinations", ["status"], run, { given })).toBe(0);
  });

  test("--json prints the same rows and problems", async () => {
    const run = setup();
    const given = { "rotated dates": METADATA };
    expect(await record("fresh-map-json", ["status", "--json"], run, { given })).toBe(0);
  });

  test("no registered projects", async () => {
    expect(await record("no-projects", ["status"], fakeDeps())).toBe(0);
    expect(await record("no-projects-json", ["status", "--json"], fakeDeps())).toBe(0);
  });

  test("a registered folder without a map, or with a bad one, is a problem", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/billing", "/work/web"),
      "/work/web/secretspec.toml": "[keys.x]\nenv = 1\n",
    });
    const { deps, stdout } = fakeDeps({ disk: files });
    expect(await cli(["status"], deps)).toBe(1);
    expect(stdout.text).toContain("billing /work/billing\nweb /work/web\n\n2 problems\n");
    expect(stdout.text).toContain("  /work/billing has no readable secretspec.toml\n");
    expect(stdout.text).toContain("  /work/web/secretspec.toml: ");
  });

  test("a project still on the init template, or with no keys, is a problem that points at check", async () => {
    for (const map of [
      TEMPLATE,
      `[project]\nname = "billing"\nrevision = "1.0"\n\n[profiles.dev]\n\n[profiles.prod]\n`,
    ]) {
      const files = memoryFiles({
        [REGISTRY]: registryWith("/work/billing"),
        "/work/billing/secretspec.toml": map,
      });
      const { deps, stdout, stderr } = fakeDeps({ disk: files });
      expect(await cli(["status"], deps)).toBe(1);
      expect(stdout.text).toContain(
        "  /work/billing/secretspec.toml maps no keys yet (it's empty, or still the keypin init template); run keypin check in /work/billing for what to add",
      );
      expect(stderr.text).toBe("");
    }
  });

  test("an unreadable secretspec.toml is reported for its project, and the others still show", async () => {
    for (const json of [false, true]) {
      const disk = memoryFiles({
        [REGISTRY]: registryWith("/work/billing", "/work/web"),
        "/work/web/secretspec.toml": WEB_MAP,
      });
      disk.files.read = async (path) => {
        if (path === "/work/billing/secretspec.toml") throw new Error("EACCES: permission denied");
        return disk.contents.get(path) ?? null;
      };
      const { deps, stdout, stderr } = fakeDeps({
        disk,
        backend: fakeVault({ metadata: METADATA }).vault,
      });
      expect(await cli(json ? ["status", "--json"] : ["status"], deps)).toBe(1);
      expect(stderr.text).toContain(
        "couldn't read /work/billing/secretspec.toml: EACCES: permission denied",
      );
      if (json) {
        const problems: unknown = expect.arrayContaining([
          expect.objectContaining({ kind: "no-map", project: "/work/billing" }),
        ]);
        expect(parseJson(stdout.text)).toMatchObject({
          rows: [{ keyId: "SESSION_SECRET" }, { keyId: "SESSION_SECRET" }],
          problems,
        });
      } else {
        expect(stdout.text).toMatch(/SESSION_SECRET {2}prod/);
        expect(stdout.text).toContain("  /work/billing has no readable secretspec.toml");
      }
    }
  });
});

describe("keypin status: a rotations.json left by keypin rotate", () => {
  test("is ignored, even when it isn't valid JSON", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/web"),
      "/work/web/secretspec.toml": WEB_MAP,
      "/home/me/.local/state/keypin/rotations.json": "{ not json",
    });
    const fake = fakeVault({ metadata: METADATA });
    const { deps, stdout } = fakeDeps({ disk: files, backend: fake.vault });
    expect(await cli(["status"], deps)).toBe(0);
    expect(stdout.text).not.toContain("rotation");
    expect(stdout.text).toContain("  web SESSION_SECRET (prod): not published yet");
    expect(files.contents.get("/home/me/.local/state/keypin/rotations.json")).toBe("{ not json");
  });
});

describe("keypin status: reads at a glance", () => {
  const ROTATIONS = `
[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.dev]
LATE = { description = "LATE", ref = { item = "late", field = "password" } }
YESTERDAY = { description = "YESTERDAY", ref = { item = "yesterday", field = "password" } }
TODAY = { description = "TODAY", ref = { item = "today", field = "password" } }
TOMORROW = { description = "TOMORROW", ref = { item = "tomorrow", field = "password" } }
UNDATED = { description = "UNDATED", ref = { item = "undated", field = "password" } }
FOREVER = { description = "FOREVER", ref = { item = "forever", field = "password" } }

[tool.keypin.dev.LATE]
rotate_every = "30d"

[tool.keypin.dev.YESTERDAY]
rotate_every = "30d"
issuer = { kind = "resend", admin = "op://Private/resend admin/password", permission = "full_access" }

[tool.keypin.dev.TODAY]
rotate_every = "30d"

[tool.keypin.dev.TOMORROW]
rotate_every = "30d"

[tool.keypin.dev.UNDATED]
rotate_every = "30d"

[tool.keypin.dev.FOREVER]
rotate_every = "never"
`;
  const ROTATED = {
    late: { rotated: "2026-10-05" },
    yesterday: { rotated: "2026-10-09" },
    today: { rotated: "2026-10-10" },
    tomorrow: { rotated: "2026-10-11" },
    forever: { rotated: "2020-01-01" },
  };
  const rotations = (styled = false) =>
    fakeDeps({
      disk: memoryFiles({
        [REGISTRY]: registryWith("/home/me/code/app"),
        "/home/me/code/app/secretspec.toml": ROTATIONS,
      }),
      backend: fakeVault({ metadata: ROTATED }).vault,
      deps: { styled: { stdout: styled, stderr: styled } },
    });

  test("says when each key is due in words, counted from today, and problems come last with what to do next", async () => {
    const given = { "rotated dates": ROTATED };
    expect(await record("due-in-words", ["status"], rotations(), { given })).toBe(1);
  });

  test("a key due soon with destinations names the publish to run, and where", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/web"),
      "/work/web/secretspec.toml": WEB_MAP,
    });
    const { deps, stdout } = fakeDeps({
      disk: files,
      backend: fakeVault({
        metadata: { ...METADATA, "web prod session secret": { rotated: "2026-05-19" } },
      }).vault,
    });
    expect(await cli(["status"], deps)).toBe(0);
    expect(stdout.text).toContain("  SESSION_SECRET  prod  due in 6 days    · Cloudflare");
    expect(stdout.text).toContain(
      "  web SESSION_SECRET (prod): is due 2026-11-15 (rotated 2026-05-19, every 180d)\n    Put a new value in the 1Password item and set rotated to today, then run keypin publish SESSION_SECRET in /work/web.\n",
    );
  });

  function dueWithIssuer(deps: Partial<Deps> = {}) {
    const issuer = `issuer = { kind = "resend", admin = "op://Private/resend admin/password", permission = "full_access" }`;
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/web"),
      "/work/web/secretspec.toml": WEB_MAP.replace(
        'worker = "web" }]',
        `worker = "web" }]\n${issuer}`,
      ),
    });
    return fakeDeps({
      disk: files,
      backend: fakeVault({
        metadata: { ...METADATA, "web prod session secret": { rotated: "2026-05-19" } },
      }).vault,
      deps,
    });
  }

  test("a due key with an issuer and destinations names the rotate to run", async () => {
    const { deps, stdout } = dueWithIssuer();
    expect(await cli(["status"], deps)).toBe(0);
    expect(stdout.text).toContain(
      "  web SESSION_SECRET (prod): is due 2026-11-15 (rotated 2026-05-19, every 180d)\n    Run keypin rotate SESSION_SECRET in /work/web.\n",
    );
  });

  test("a 1Password service account is told to run keypin rotate too", async () => {
    const { deps, stdout } = dueWithIssuer({
      signIn: () => ({ mode: "service-account", address: "my.1password.com" }),
    });
    expect(await cli(["status"], deps)).toBe(0);
    expect(stdout.text).toContain("    Run keypin rotate SESSION_SECRET in /work/web.\n");
  });

  test("groups keys under each project, in the registry's order", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/web", "/home/me/code/billing"),
      "/home/me/code/billing/secretspec.toml": BILLING_MAP,
      "/work/web/secretspec.toml": WEB_MAP,
    });
    const { deps, stdout } = fakeDeps({
      disk: files,
      backend: fakeVault({ metadata: METADATA }).vault,
    });
    await cli(["status"], deps);
    const heads = stdout.text.split("\n").filter((line) => !line.startsWith(" ") && line);
    expect(heads.slice(0, 2)).toEqual(["web /work/web", "billing ~/code/billing"]);
    expect(stdout.text).toMatch(
      /^web \/work\/web\n {2}SESSION_SECRET {2}dev .*\n {2}SESSION_SECRET {2}prod .*\nbilling ~\/code\/billing\n {2}STRIPE_API_KEY {2}dev .*\n {2}STRIPE_API_KEY {2}prod /,
    );
  });

  test("a notice names the whole repository and environment, even when they contain environments/", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/billing"),
      "/work/billing/secretspec.toml": BILLING_MAP.replace(
        '{ to = "github-actions", repo = "acme/billing" },',
        '{ to = "github-actions", repo = "acme/environments", environment = "production" },\n  { to = "github-actions", repo = "acme/billing", environment = "preview/environments/feature" },',
      ),
    });
    const { deps, stdout } = fakeDeps({
      disk: files,
      backend: fakeVault({ metadata: METADATA }).vault,
    });
    await cli(["status"], deps);
    expect(stdout.text).toContain(
      "not published yet to the Worker billing-worker, GitHub acme/environments environment production, GitHub acme/billing environment preview/environments/feature;",
    );
  });

  test("marks each destination that has a receipt, and names the place when one service has two", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/billing"),
      "/work/billing/secretspec.toml": BILLING_MAP.replace(
        '{ to = "github-actions", repo = "acme/billing" },',
        '{ to = "github-actions", repo = "acme/billing" },\n  { to = "github-actions", repo = "acme/billing", environment = "production" },',
      ),
      [STATE]: JSON.stringify({
        version: 3,
        operations: [],
        receipts: [
          {
            keyId: "STRIPE_API_KEY",
            environment: "prod",
            destinationId: "github-actions:acme/billing:STRIPE_API_KEY",
            generation: "0123456789abcdef",
            account: { pinned: "acme/billing", publisher: "acme", destinationAccount: "acme" },
            at: "2026-11-09T15:30:35Z",
            evidence: { versionId: "v1" },
            mapFile: "/work/billing/secretspec.toml",
            source: null,
          },
        ],
      }),
    });
    for (const styled of [false, true]) {
      const { deps, stdout } = fakeDeps({
        disk: files,
        backend: fakeVault({ metadata: METADATA }).vault,
        deps: { styled: { stdout: styled, stderr: false } },
      });
      await cli(["status"], deps);
      const prod = stdout.text.split("\n").find((line) => line.includes("prod")) ?? "";
      if (styled) {
        expect(prod).toContain("\x1b[32m✓\x1b[0m GitHub acme/billing");
        expect(prod).toContain("\x1b[2m·\x1b[0m Cloudflare \x1b[2mno receipt\x1b[0m");
      } else {
        expect(prod).toBe(
          "  STRIPE_API_KEY  prod  due in 348 days  · Cloudflare no receipt  ok GitHub acme/billing  · GitHub acme/billing/environments/production no receipt",
        );
      }
    }
  });

  test("styles only a terminal: red for a rotation problem, and no escape codes in plain text", async () => {
    const styled = rotations(true);
    await cli(["status"], styled.deps);
    expect(styled.stdout.text).toContain("\x1b[1mapp\x1b[0m \x1b[2m~/code/app\x1b[0m");
    expect(styled.stdout.text).toContain("\x1b[1;31m5 days overdue\x1b[0m");
    expect(styled.stdout.text).toContain("\x1b[1;31mrotation unknown\x1b[0m");
    expect(styled.stdout.text).toContain("\x1b[2mnever rotates\x1b[0m");
    expect(styled.stdout.text).toContain("\x1b[1;31m3 problems\x1b[0m");
    expect(styled.stderr.text).toContain("1Password");
    const plain = rotations();
    await cli(["status"], plain.deps);
    expect(plain.stdout.text + plain.stderr.text).not.toContain("\x1b");
  });

  test("--json keeps what the text leaves out: dates, publisher and generation", async () => {
    const state = JSON.stringify({
      version: 3,
      operations: [],
      receipts: [{ ...sessionReceipt, mapFile: "/work/web/secretspec.toml", source: null }],
    });
    const run = setup({ state });
    const given = { "rotated dates": METADATA };
    expect(await record("receipt-json", ["status", "--json"], run, { given })).toBe(0);
  });

  test("while 1Password is slow, the approval hint fits an 80-column terminal", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeVault({ metadata: METADATA });
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const { deps, stderr } = fakeDeps({
        disk: memoryFiles({
          [REGISTRY]: registryWith("/work/billing", "/work/web"),
          "/work/billing/secretspec.toml": BILLING_MAP,
          "/work/web/secretspec.toml": WEB_MAP,
        }),
        backend: {
          ...fake.vault,
          metadata: async (ref) => {
            await held;
            return fake.vault.metadata(ref);
          },
        },
        deps: { styled: { stdout: false, stderr: true }, columns: () => 80 },
      });
      const run = cli(["status"], deps);
      await vi.advanceTimersByTimeAsync(1500);
      const frames = stderr.text.split("\r\x1b[2K").filter(Boolean);
      const last = stripVTControlCharacters(frames.at(-1) ?? "");
      expect(last).toContain("1Password may be asking you to approve keypin");
      expect(last.length).toBeLessThanOrEqual(79);
      release();
      expect(await run).toBe(0);
      expect(stripVTControlCharacters(stderr.text)).toContain(
        "✓ Read 3 rotated dates from 1Password account my.1password.com, not the values",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("keypin status --write", () => {
  const FILE = "/work/billing/.keypin/status.json";

  test("writes only this project's rotated dates, and no reference, path or receipt", async () => {
    const run = setup();
    const given = { "rotated dates": METADATA };
    const calls = { vault: run.calls };
    expect(await record("write", ["status", "--write"], run, { given, calls })).toBe(0);
    expect(await run.deps.files.read(FILE)).not.toMatch(
      /op:|billing stripe|Private|my\.1password|\/work|SESSION_SECRET/,
    );
  });

  test("leaves the file alone when the dates haven't changed", async () => {
    const { deps, stderr } = setup();
    expect(await cli(["status", "--write"], deps)).toBe(0);
    const first = await deps.files.read(FILE);
    deps.now = () => new Date(2026, 10, 20, 12, 0, 0);
    expect(await cli(["status", "--write"], deps)).toBe(0);
    expect(await deps.files.read(FILE)).toBe(first);
    expect(stderr.text).toContain(
      "ok     /work/billing/.keypin/status.json has these dates already; left it as it is\n",
    );
  });

  test("a key with no rotated date is null", async () => {
    const files = memoryFiles({ "/work/billing/secretspec.toml": BILLING_MAP });
    const { deps } = fakeDeps({ disk: files, backend: fakeVault().vault });
    expect(await cli(["status", "--write"], deps)).toBe(0);
    expect(parseJson((await deps.files.read(FILE)) ?? "")).toEqual({
      version: 1,
      written: "2026-11-09",
      keys: { STRIPE_API_KEY: { dev: { rotated: null }, prod: { rotated: null } } },
    });
  });

  test("an unreadable date leaves the file as it is and exits 1", async () => {
    const { deps, stderr } = setup({ failing: ["billing stripe api key"] });
    expect(await cli(["status", "--write"], deps)).toBe(1);
    expect(await deps.files.read(FILE)).toBeNull();
    expect(stderr.text).toContain(
      "keypin: left .keypin/status.json as it is, since a rotated date couldn't be read\n",
    );
  });

  test("needs a secretspec.toml, and takes no --json", async () => {
    const empty = fakeDeps();
    expect(await cli(["status", "--write"], empty.deps)).toBe(1);
    expect(empty.stderr.text).toContain("no secretspec.toml in /work/billing");
    const both = setup();
    expect(await cli(["status", "--write", "--json"], both.deps)).toBe(2);
    expect(await both.deps.files.read(FILE)).toBeNull();
  });
});
