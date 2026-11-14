import { describe, expect, test, vi } from "vite-plus/test";
import { stripVTControlCharacters } from "node:util";
import { isRecord } from "@keypin/core";
import { cli } from "../src/cli";
import { TEMPLATE } from "../src/commands/init";
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
} from "./fakes";

const METADATA = {
  "web dev session secret": { rotated: "2026-11-09" },
  "web prod session secret": { rotated: "2026-11-09" },
  "billing stripe api key": { rotated: "2026-10-23" },
};

function setup(options: { failing?: string[]; state?: string } = {}) {
  const files = memoryFiles({
    [REGISTRY]: registryWith("/work/billing", "/work/web"),
    "/work/billing/keypin.toml": BILLING_MAP,
    "/work/web/keypin.toml": WEB_MAP,
    ...(options.state ? { [STATE]: options.state } : {}),
  });
  const fake = fakeVault({ metadata: METADATA, failing: options.failing });
  return { ...fakeDeps({ disk: files, backend: fake.vault }), calls: fake.calls };
}

describe("keypin status", () => {
  test("a fresh map lists every key, says what to publish, and exits 0", async () => {
    const { deps, stdout, stderr, calls } = setup();
    expect(await cli(["status"], deps)).toBe(0);
    expect(stdout.text).toBe(
      [
        "billing /work/billing",
        "  STRIPE_API_KEY  dev   due in 348 days",
        "  STRIPE_API_KEY  prod  due in 348 days  · Cloudflare not published  · GitHub not published",
        "web /work/web",
        "  SESSION_SECRET  dev   due in 180 days",
        "  SESSION_SECRET  prod  due in 180 days  · Cloudflare not published",
        "",
        "2 notices",
        "  billing STRIPE_API_KEY (prod): not published yet to the Worker billing-worker, GitHub acme/billing; run keypin publish STRIPE_API_KEY",
        "  web SESSION_SECRET (prod): not published yet to the Worker web; run keypin publish SESSION_SECRET",
        "",
      ].join("\n"),
    );
    expect(stdout.text).not.toContain("authority");
    expect(calls.toSorted()).toEqual([
      "metadata billing stripe api key",
      "metadata web dev session secret",
      "metadata web prod session secret",
    ]);
    expect(stderr.text).toBe(
      "ok     Read 3 rotated dates from 1Password account my.1password.com, not the values\n",
    );
  });

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
      receipts: [{ ...sessionReceipt, mapFile: "/work/web/keypin.toml", source: null }],
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
      "/work/web/keypin.toml": WEB_MAP.replace(
        'worker = "web" },',
        'worker = "web" },\n  { to = "github-actions", repo = "acme/web" },',
      ),
      [STATE]: JSON.stringify({
        version: 3,
        operations: [],
        receipts: [{ ...sessionReceipt, mapFile: "/work/web/keypin.toml", source: null }],
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
    const { deps, stdout, stderr } = setup({ failing: ["billing stripe api key"] });
    expect(await cli(["status"], deps)).toBe(1);
    expect(stdout.text).toMatch(/STRIPE_API_KEY {2}prod {2}rotation unknown/);
    expect(stdout.text.match(/rotated date couldn't be read/g)).toHaveLength(2);
    expect(stderr.text).toBe(
      [
        "FAILED Couldn't read 1 of 3 rotated dates from 1Password account my.1password.com, not the values",
        `keypin: 1Password: "billing stripe api key" isn't readable`,
        "",
      ].join("\n"),
    );
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
      "/work/billing/keypin.toml": BILLING_MAP.replace(/publish = \[[\s\S]*?\] \}/, "}"),
    });
    const { deps, stdout } = fakeDeps({
      disk: files,
      backend: fakeVault({ metadata: METADATA }).vault,
    });
    expect(await cli(["status"], deps)).toBe(0);
    expect(stdout.text).toBe(
      "billing /work/billing\n  STRIPE_API_KEY  dev   due in 348 days\n  STRIPE_API_KEY  prod  due in 348 days\n",
    );
  });

  test("--json prints the same rows and problems", async () => {
    const { deps, stdout } = setup();
    expect(await cli(["status", "--json"], deps)).toBe(0);
    expect(parseJson(stdout.text)).toMatchObject({
      today: "2026-11-09",
      rows: [
        { keyId: "STRIPE_API_KEY", environment: "dev", due: "2027-10-23" },
        { keyId: "STRIPE_API_KEY", environment: "prod", due: "2027-10-23" },
        { keyId: "SESSION_SECRET", environment: "dev", due: "2027-05-08" },
        { keyId: "SESSION_SECRET", environment: "prod", due: "2027-05-08" },
      ],
    });
    expect(parseJson(stdout.text)).toMatchObject({
      problems: [
        { kind: "never-published", severity: "notice", keyId: "STRIPE_API_KEY" },
        { kind: "never-published", severity: "notice", keyId: "SESSION_SECRET" },
      ],
    });
    expect(stdout.text).not.toContain("authority");
  });

  test("no registered projects", async () => {
    const { deps, stdout, stderr } = fakeDeps();
    expect(await cli(["status"], deps)).toBe(0);
    expect(stdout.text).toBe(`No projects registered. Run "keypin init" in a project folder.\n`);
    expect(stderr.text).toBe("");
    const json = fakeDeps();
    expect(await cli(["status", "--json"], json.deps)).toBe(0);
    expect(parseJson(json.stdout.text)).toEqual({ today: "2026-11-09", rows: [], problems: [] });
  });

  test("a registered folder without a map, or with a bad one, is a problem", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/billing", "/work/web"),
      "/work/web/keypin.toml": "[keys.x]\nenv = 1\n",
    });
    const { deps, stdout } = fakeDeps({ disk: files });
    expect(await cli(["status"], deps)).toBe(1);
    expect(stdout.text).toContain("billing /work/billing\nweb /work/web\n\n2 problems\n");
    expect(stdout.text).toContain("  /work/billing has no readable keypin.toml\n");
    expect(stdout.text).toContain("  /work/web/keypin.toml: ");
  });

  test("a project still on the init template, or with no keys, is a problem that points at check", async () => {
    for (const map of [TEMPLATE, `[1password]\naccount = "my.1password.com"\n`]) {
      const files = memoryFiles({
        [REGISTRY]: registryWith("/work/billing"),
        "/work/billing/keypin.toml": map,
      });
      const { deps, stdout, stderr } = fakeDeps({ disk: files });
      expect(await cli(["status"], deps)).toBe(1);
      expect(stdout.text).toContain(
        "  /work/billing/keypin.toml maps no keys yet (it's empty, or still the keypin init template); run keypin check in /work/billing for what to add",
      );
      expect(stderr.text).toBe("");
    }
  });

  test("an unreadable keypin.toml is reported for its project, and the others still show", async () => {
    for (const json of [false, true]) {
      const disk = memoryFiles({
        [REGISTRY]: registryWith("/work/billing", "/work/web"),
        "/work/web/keypin.toml": WEB_MAP,
      });
      disk.files.read = async (path) => {
        if (path === "/work/billing/keypin.toml") throw new Error("EACCES: permission denied");
        return disk.contents.get(path) ?? null;
      };
      const { deps, stdout, stderr } = fakeDeps({
        disk,
        backend: fakeVault({ metadata: METADATA }).vault,
      });
      expect(await cli(json ? ["status", "--json"] : ["status"], deps)).toBe(1);
      expect(stderr.text).toContain(
        "couldn't read /work/billing/keypin.toml: EACCES: permission denied",
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
        expect(stdout.text).toContain("  /work/billing has no readable keypin.toml");
      }
    }
  });
});

describe("keypin status: a rotations.json left by keypin rotate", () => {
  test("is ignored, even when it isn't valid JSON", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/web"),
      "/work/web/keypin.toml": WEB_MAP,
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
[1password]
account = "my.1password.com"

[keys.LATE]
rotate_every = "30d"
dev = "op://Private/late/password"

[keys.YESTERDAY]
rotate_every = "30d"
dev = "op://Private/yesterday/password"

[keys.TODAY]
rotate_every = "30d"
dev = "op://Private/today/password"

[keys.TOMORROW]
rotate_every = "30d"
dev = "op://Private/tomorrow/password"

[keys.UNDATED]
rotate_every = "30d"
dev = "op://Private/undated/password"

[keys.FOREVER]
rotate_every = "never"
dev = "op://Private/forever/password"
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
        "/home/me/code/app/keypin.toml": ROTATIONS,
      }),
      backend: fakeVault({ metadata: ROTATED }).vault,
      deps: { styled: { stdout: styled, stderr: styled } },
    });

  test("says when each key is due in words, counted from today", async () => {
    const { deps, stdout } = rotations();
    expect(await cli(["status"], deps)).toBe(1);
    expect(stdout.text).toContain(
      [
        "app ~/code/app",
        "  LATE       dev  5 days overdue",
        "  YESTERDAY  dev  1 day overdue",
        "  TODAY      dev  due today",
        "  TOMORROW   dev  due in 1 day",
        "  UNDATED    dev  rotation unknown",
        "  FOREVER    dev  never rotates",
        "",
      ].join("\n"),
    );
  });

  test("problems come last, each with what to do next", async () => {
    const { deps, stdout } = rotations();
    await cli(["status"], deps);
    const problems = stdout.text.slice(stdout.text.indexOf("\n3 problems\n"));
    expect(problems).toBe(
      [
        "",
        "3 problems",
        "  app LATE (dev): was due 2026-11-04 (rotated 2026-10-05, every 30d)",
        "    Put a new value in the 1Password item and set rotated to today.",
        "  app YESTERDAY (dev): was due 2026-11-08 (rotated 2026-10-09, every 30d)",
        "    Put a new value in the 1Password item and set rotated to today.",
        "  app UNDATED (dev): no rotated date",
        "    Add a rotated Date field to the 1Password item, with the day the value last changed.",
        "",
        "2 notices",
        "  app TODAY (dev): is due 2026-11-09 (rotated 2026-10-10, every 30d)",
        "    Put a new value in the 1Password item and set rotated to today.",
        "  app TOMORROW (dev): is due 2026-11-10 (rotated 2026-10-11, every 30d)",
        "    Put a new value in the 1Password item and set rotated to today.",
        "",
      ].join("\n"),
    );
  });

  test("a key due soon with destinations names the publish to run, and where", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/web"),
      "/work/web/keypin.toml": WEB_MAP,
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

  test("groups keys under each project, in the registry's order", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/web", "/home/me/code/billing"),
      "/home/me/code/billing/keypin.toml": BILLING_MAP,
      "/work/web/keypin.toml": WEB_MAP,
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

  test("marks each destination that has a receipt, and names the place when one service has two", async () => {
    const files = memoryFiles({
      [REGISTRY]: registryWith("/work/billing"),
      "/work/billing/keypin.toml": BILLING_MAP.replace(
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
            mapFile: "/work/billing/keypin.toml",
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
      receipts: [
        {
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
          mapFile: "/work/web/keypin.toml",
          source: null,
        },
      ],
    });
    const { deps, stdout } = setup({ state });
    expect(await cli(["status", "--json"], deps)).toBe(0);
    const json = parseJson(stdout.text);
    expect(json).toMatchObject({ rows: [{}, {}, {}, {}] });
    const rows = isRecord(json) && Array.isArray(json.rows) ? json.rows : [];
    expect(rows[3]).toEqual({
      project: "/work/web",
      keyId: "SESSION_SECRET",
      environment: "prod",
      ref: {
        kind: "1password",
        account: "my.1password.com",
        vault: "Private",
        item: "web prod session secret",
        section: null,
        field: "password",
      },
      rotated: "2026-11-09",
      rotateEvery: "180d",
      due: "2027-05-08",
      destinations: [
        {
          destinationId: "cloudflare-worker:web:SESSION_SECRET",
          account: "11111111111111111111111111111111",
          receipt: {
            generation: "0123456789abcdef",
            at: "2026-11-09T15:30:35Z",
            publisher: "me@example.com",
          },
          stale: null,
        },
      ],
    });
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
          "/work/billing/keypin.toml": BILLING_MAP,
          "/work/web/keypin.toml": WEB_MAP,
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
