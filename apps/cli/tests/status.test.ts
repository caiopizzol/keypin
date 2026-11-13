import { describe, expect, test } from "vite-plus/test";
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
    expect(stdout.text).toMatch(
      /SESSION_SECRET\s+dev\s+op:\/\/Private\/web dev session secret\/password\s+2026-11-09\s+180d\s+2027-05-08/,
    );
    expect(stdout.text).toMatch(/SESSION_SECRET\s+prod.+2026-11-09\s+180d\s+2027-05-08/);
    expect(stdout.text).toMatch(/STRIPE_API_KEY\s+prod.+2026-10-23\s+365d\s+2027-10-23/);
    expect(stdout.text).toContain(
      "-> cloudflare-worker:billing-worker:STRIPE_API_KEY (account 11111111111111111111111111111111): no receipt",
    );
    expect(stdout.text).not.toContain("Problems");
    expect(stdout.text).toContain("Notices (2):");
    expect(stdout.text).toContain(
      "never-published: STRIPE_API_KEY (prod): not published yet to cloudflare-worker:billing-worker:STRIPE_API_KEY, github-actions:acme/billing:STRIPE_API_KEY; run keypin publish STRIPE_API_KEY",
    );
    expect(stdout.text).toContain(
      "never-published: SESSION_SECRET (prod): not published yet to cloudflare-worker:web:SESSION_SECRET; run keypin publish SESSION_SECRET",
    );
    expect(stdout.text).not.toContain("authority");
    expect(calls.toSorted()).toEqual([
      "metadata billing stripe api key",
      "metadata web dev session secret",
      "metadata web prod session secret",
    ]);
    expect(stderr.text).toContain(
      "keypin: reading rotated dates; no values are shown from 1Password account my.1password.com: op://Private/billing stripe api key/password,",
    );
    expect(stderr.text).toContain("op://Private/web prod session secret/password");
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
      "-> cloudflare-worker:web:SESSION_SECRET (account 11111111111111111111111111111111): no receipt",
    );
    expect(stdout.text).toContain(
      "missing-receipt: SESSION_SECRET (prod): cloudflare-worker:web:SESSION_SECRET's last receipt isn't from this project or this key's item",
    );
    expect(stdout.text.match(/missing-receipt/g)).toHaveLength(1);
    expect(stdout.text.match(/never-published/g)).toHaveLength(1);
  });

  test("shows a destination's last receipt", async () => {
    const state = JSON.stringify({
      version: 3,
      operations: [],
      receipts: [{ ...sessionReceipt, mapFile: "/work/web/keypin.toml", source: null }],
    });
    const { deps, stdout } = setup({ state });
    await cli(["status"], deps);
    expect(stdout.text).toContain(
      "-> cloudflare-worker:web:SESSION_SECRET (account 11111111111111111111111111111111): last published 2026-11-09T15:30:35Z by me@example.com, generation 0123456789abcdef",
    );
    expect(stdout.text).not.toContain("missing-receipt");
    expect(stdout.text.match(/never-published/g)).toHaveLength(1);
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
    expect(stdout.text).toContain("Problems (1):");
    expect(stdout.text).toContain(
      "missing-receipt: SESSION_SECRET (prod): no receipt for github-actions:acme/web:SESSION_SECRET, though this project published this key before, so what it holds is unknown; keypin publish SESSION_SECRET writes it again",
    );
    expect(stdout.text).not.toContain("never-published");
  });

  test("a failing metadata read is rotation-unreadable, never nothing due", async () => {
    const { deps, stdout, stderr } = setup({ failing: ["billing stripe api key"] });
    expect(await cli(["status"], deps)).toBe(1);
    expect(stdout.text).toMatch(/STRIPE_API_KEY\s+prod.+\s-\s+365d\s+unknown/);
    expect(stdout.text.match(/rotation-unreadable/g)).toHaveLength(2);
    expect(stderr.text).toContain(`"billing stripe api key" isn't readable`);
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
    expect(stdout.text).not.toContain("Problems");
    expect(stdout.text).not.toContain("Notices");
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
    expect(stdout.text).toContain("No projects registered");
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
    expect(stdout.text).toContain("no-map: /work/billing has no readable keypin.toml");
    expect(stdout.text).toContain("bad-map:");
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
        "no-keys: /work/billing/keypin.toml maps no keys yet (it's empty, or still the keypin init template); run keypin check in /work/billing for what to add",
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
        expect(stdout.text).toMatch(/SESSION_SECRET\s+prod/);
        expect(stdout.text).toContain("no-map: /work/billing has no readable keypin.toml");
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
    expect(stdout.text).toContain("never-published: SESSION_SECRET (prod)");
    expect(files.contents.get("/home/me/.local/state/keypin/rotations.json")).toBe("{ not json");
  });
});
