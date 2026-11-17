import { describe, expect, test } from "vite-plus/test";
import {
  type Destination,
  type Issuer,
  loadState,
  type PublishTarget,
  Secret,
  type VaultBackend,
  WriteRefused,
} from "@keypin/core";
import { onePasswordRef } from "@keypin/connectors/onepassword";
import { cli } from "../src/cli";
import { issuers, vaults } from "../src/start";
import { NEEDS_APPROVAL } from "../src/approval";
import { fakeDeps, fakeDestinations, memoryFiles, STATE, writableVault } from "./fakes";
import { pairedKind } from "./paired";

const OLD_SECRET = "old_secret_sentinel_5c1e";
const ADMIN = "admin_sentinel_value_3f7a";
const NEW = (n: number) => `new_secret_sentinel_${n}_8d2b`;
const WORKER = "cloudflare-worker:api";
const GITHUB = "github-actions:acme/api";

const VALUES = { "api secret": OLD_SECRET, "api key id": "AKID-0", "keys admin": ADMIN };

const PUBLISH = `publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "api" },
  { to = "github-actions", repo = "acme/api" },
]`;

const MAP = `
[1password]
account = "my.1password.com"

[keys.API_SECRET]
rotate_every = "90d"

[keys.API_SECRET.prod]
from = "op://Private/api secret/credential"
${PUBLISH}

[keys.API_SECRET.prod.issuer]
kind = "paired"
admin = "op://Private/keys admin/credential"
key_id = "API_KEY_ID"

[keys.API_KEY_ID]
rotate_every = "never"

[keys.API_KEY_ID.prod]
from = "op://Private/api key id/credential"
${PUBLISH}
`;

interface IssuerOptions {
  failCreate?: boolean;
  gone?: string;
}

function pairedIssuer(options: IssuerOptions) {
  const log: string[] = [];
  const live = new Set(["AKID-0"]);
  const made = { count: 0 };
  const build = (): Issuer => ({
    describe: () => "Keys",
    dashboard: () => "https://keys.example/keys",
    async checkAccount(current) {
      log.push(`check ${current ?? "none"}`);
      if (current === options.gone)
        return {
          ok: true,
          facts: "the admin key lists 0 keys",
          gone: `key ${current} was deleted`,
        };
      if (current === null || !live.has(current))
        return {
          ok: false,
          facts: `the admin key lists ${live.size} keys`,
          reason: `the account doesn't list key ${current ?? "(none)"}`,
        };
      return { ok: true, facts: `the admin key lists ${live.size} keys`, currentId: current };
    },
    async create(name) {
      if (options.failCreate) throw new Error("POST /keys returned HTTP 500");
      made.count++;
      const id = `AKID-${made.count}`;
      live.add(id);
      log.push(`create ${name.split(" ")[0]} -> ${id}`);
      return { id, secret: new Secret(NEW(made.count)) };
    },
    async revoke(id) {
      log.push(`revoke ${id}`);
      return live.delete(id) ? "revoked" : "already gone";
    },
  });
  return { build, log, live, made };
}

type SaveFailure = "refused" | "unknown" | "after saving";

function failingVault(base: VaultBackend, failures: Map<string, SaveFailure>): VaultBackend {
  return {
    ...base,
    async write(ref, secret, options) {
      const item = onePasswordRef(ref)?.item ?? "";
      const failure = failures.get(item);
      failures.delete(item);
      if (failure === "refused") throw new WriteRefused("the account can't write to this vault");
      if (failure === "unknown") throw new Error("1Password: the request timed out");
      await base.write(ref, secret, options);
      if (failure === "after saving") throw new Error("1Password: the request timed out");
    },
  };
}

interface Setup {
  answers?: string[];
  disk?: ReturnType<typeof memoryFiles>;
  vault?: ReturnType<typeof writableVault>;
  issuer?: ReturnType<typeof pairedIssuer>;
  saves?: Record<string, SaveFailure>;
  failName?: { place: string; name: string };
  map?: string;
  failCreate?: boolean;
  gone?: string;
}

function setup(options: Setup = {}) {
  const disk = options.disk ?? memoryFiles({ "/work/billing/keypin.toml": options.map ?? MAP });
  const vault = options.vault ?? writableVault(VALUES);
  const issuer = options.issuer ?? pairedIssuer(options);
  const destinations = fakeDestinations();
  const failName = options.failName;
  const build = (target: PublishTarget): Destination => {
    const real = destinations.build(target);
    if (!failName || real.describe() !== failName.place) return real;
    return {
      ...real,
      checkAccount: () => real.checkAccount(),
      async write(name, secret) {
        if (name === failName.name) throw new Error(`HTTP 500 writing ${name}`);
        return real.write(name, secret);
      },
    };
  };
  const answers = [...(options.answers ?? [])];
  const asked: string[] = [];
  const fake = fakeDeps({
    disk,
    backend: failingVault(vault.vault, new Map(Object.entries(options.saves ?? {}))),
    deps: {
      issuers: [...issuers, pairedKind],
      destination: build,
      issuer: issuer.build,
      isTerminal: true,
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
    },
  });
  const rotate = (key = "API_SECRET") => cli(["rotate", key], fake.deps);
  const writes = () => destinations.log.filter((l) => l.startsWith("write"));
  const state = () => loadState(disk.files, STATE, vaults);
  const leaked = () =>
    [OLD_SECRET, ADMIN, NEW(1), NEW(2)].some((v) =>
      [fake.stderr.text, fake.stdout.text, ...disk.contents.values()].join("\n").includes(v),
    );
  const again = (more: Setup = {}) => setup({ disk, vault, issuer, ...more });
  return {
    ...fake,
    disk,
    vault,
    issuer,
    destinations,
    asked,
    rotate,
    writes,
    state,
    leaked,
    again,
  };
}

const pairOf = (run: ReturnType<typeof setup>) => [
  run.vault.values.get("api secret"),
  run.vault.values.get("api key id"),
];

describe("keypin rotate: a key whose ID is another key", () => {
  test("checks the vault's ID, saves the secret then the ID, publishes both, and revokes the old key", async () => {
    const run = setup({ answers: ["y", "y"] });
    expect(await run.rotate()).toBe(0);
    expect(run.issuer.log).toEqual([
      "check AKID-0",
      "create API_SECRET -> AKID-1",
      "revoke AKID-0",
    ]);
    expect(pairOf(run)).toEqual([NEW(1), "AKID-1"]);
    expect(run.vault.rotated).toEqual(["2026-11-09", "2026-11-09"]);
    expect(run.writes()).toEqual([
      `write ${WORKER} API_SECRET API_KEY_ID in one request`,
      `write ${GITHUB} API_SECRET (${NEW(1).length} chars)`,
      `write ${GITHUB} API_KEY_ID (6 chars)`,
    ]);
    expect(run.stderr.text).toContain(
      [
        "Plan",
        "  + Keys                  create a new key",
        "  ~ 1Password             save it to op://Private/api secret/credential, rotated today",
        "  ~ 1Password             save its ID to op://Private/api key id/credential, rotated today",
        "  + Cloudflare  api       API_SECRET: first write  needs approval",
        "  + Cloudflare  api       API_KEY_ID: first write  needs approval",
        "    writing a Worker secret deploys a new version of the Worker",
        "  + GitHub      acme/api  API_SECRET: first write  needs approval",
        "  + GitHub      acme/api  API_KEY_ID: first write  needs approval",
        "  - Keys                  revoke the old key AKID-0, after a second y",
        "  GitHub acme/api gets API_SECRET and API_KEY_ID one write after the other; a run that starts between them reads a mismatched pair. Pause new runs there until the rotation finishes.",
      ].join("\n"),
    );
    const state = await run.state();
    const [issued] = state.issued;
    expect(issued).toMatchObject({ id: "AKID-1", idKey: "API_KEY_ID" });
    expect(issued?.old).toMatchObject({ id: "AKID-0", revoked: true });
    expect(state.receipts.map((r) => `${r.keyId} ${r.destinationId}`).toSorted()).toEqual([
      `API_KEY_ID ${WORKER}:API_KEY_ID`,
      `API_KEY_ID ${GITHUB}:API_KEY_ID`,
      `API_SECRET ${WORKER}:API_SECRET`,
      `API_SECRET ${GITHUB}:API_SECRET`,
    ]);
    expect(
      state.receipts.find((r) => r.keyId === "API_KEY_ID")?.sourceIds,
      "the ID's receipt names the ID's own item",
    ).toEqual({ vault: "v1", item: "id-api key id" });
    expect(run.leaked()).toBe(false);
  });

  test("a vault ID the account doesn't list stops before anything is created", async () => {
    const vault = writableVault({ ...VALUES, "api key id": "AKID-typo" });
    const run = setup({ vault, answers: ["y"] });
    expect(await run.rotate()).toBe(1);
    expect(run.issuer.log).toEqual(["check AKID-typo"]);
    expect(run.asked).toEqual([]);
  });

  test("a secret save that fails without saving revokes the unsaved key before the rerun creates another", async () => {
    const first = setup({ saves: { "api secret": "unknown" }, answers: ["y"] });
    expect(await first.rotate()).toBe(1);
    expect(pairOf(first)).toEqual([OLD_SECRET, "AKID-0"]);
    expect([...first.issuer.live]).toEqual(["AKID-0", "AKID-1"]);

    const rerun = first.again({ answers: ["y", "y"] });
    expect(await rerun.rotate()).toBe(0);
    expect(rerun.stderr.text).toContain(
      `  - Keys                  revoke key AKID-1, which keypin created on ${rerun.deps.now().toISOString()} but never saved`,
    );
    expect(rerun.issuer.log.slice(-4)).toEqual([
      "check AKID-0",
      "revoke AKID-1",
      "create API_SECRET -> AKID-2",
      "revoke AKID-0",
    ]);
    expect([...rerun.issuer.live]).toEqual(["AKID-2"]);
    expect(pairOf(rerun)).toEqual([NEW(2), "AKID-2"]);
    expect(rerun.leaked()).toBe(false);
  });

  test("a secret save the vault refuses revokes the new key, as for any key", async () => {
    const run = setup({ saves: { "api secret": "refused" }, answers: ["y"] });
    expect(await run.rotate()).toBe(1);
    expect(run.issuer.log).toEqual([
      "check AKID-0",
      "create API_SECRET -> AKID-1",
      "revoke AKID-1",
    ]);
    expect(pairOf(run)).toEqual([OLD_SECRET, "AKID-0"]);
  });

  test.each<[string, SaveFailure]>([
    ["refused", "refused"],
    ["unknown", "unknown"],
  ])(
    "an ID save that is %s keeps the new key, and the rerun saves the ID before publishing",
    async (_, failure) => {
      const first = setup({ saves: { "api key id": failure }, answers: ["y"] });
      expect(await first.rotate()).toBe(1);
      expect(first.issuer.log).toEqual(["check AKID-0", "create API_SECRET -> AKID-1"]);
      expect(pairOf(first)).toEqual([NEW(1), "AKID-0"]);
      expect(first.writes()).toEqual([]);
      expect(first.stderr.text).toContain(
        "Stopped: the new key AKID-1 is in 1Password, but its ID isn't in op://Private/api key id/credential yet. The old key still works. Run this again to save the ID and publish both:",
      );

      const rerun = first.again({ answers: ["y", "y"] });
      expect(await rerun.rotate()).toBe(0);
      expect(rerun.stderr.text).toContain("Resuming: keypin created key AKID-1");
      expect(rerun.stderr.text).toContain(
        "  ~ 1Password             save its ID to op://Private/api key id/credential, rotated today",
      );
      expect(rerun.issuer.log.slice(2)).toEqual(["check AKID-1", "revoke AKID-0"]);
      expect(pairOf(rerun)).toEqual([NEW(1), "AKID-1"]);
      expect(rerun.writes()).toEqual([
        `write ${WORKER} API_SECRET API_KEY_ID in one request`,
        `write ${GITHUB} API_SECRET (${NEW(1).length} chars)`,
        `write ${GITHUB} API_KEY_ID (6 chars)`,
      ]);
    },
  );

  test("an ID save that may have worked resumes from the vault's ID", async () => {
    const first = setup({ saves: { "api key id": "after saving" }, answers: ["y"] });
    expect(await first.rotate()).toBe(1);
    expect(pairOf(first)).toEqual([NEW(1), "AKID-1"]);

    const rerun = first.again({ answers: ["y", "y"] });
    expect(await rerun.rotate()).toBe(0);
    expect(rerun.stderr.text).not.toContain("save its ID");
    expect(rerun.issuer.log.slice(2)).toEqual(["check AKID-1", "revoke AKID-0"]);
  });

  test("a publish that stops after the secret reached a destination, but not its ID, writes the ID on the rerun before revoking", async () => {
    const first = setup({ failName: { place: GITHUB, name: "API_KEY_ID" }, answers: ["y"] });
    expect(await first.rotate()).toBe(1);
    expect(first.writes()).toEqual([
      `write ${WORKER} API_SECRET API_KEY_ID in one request`,
      `write ${GITHUB} API_SECRET (${NEW(1).length} chars)`,
    ]);
    expect(first.issuer.log).toEqual(["check AKID-0", "create API_SECRET -> AKID-1"]);

    const rerun = first.again({ answers: ["y", "y"] });
    expect(await rerun.rotate()).toBe(0);
    expect(rerun.asked).toEqual(["Write 1 secret? [y/N] ", "Revoke the old key at Keys? [y/N] "]);
    expect(rerun.writes()).toEqual([`write ${GITHUB} API_KEY_ID (6 chars)`]);
    expect(rerun.destinations.delivered("AKID-1")).toEqual([`${GITHUB} API_KEY_ID`]);
    expect(rerun.issuer.log.slice(2)).toEqual(["check AKID-1", "revoke AKID-0"]);
  });

  test("with nothing left to revoke, an ID that missed a destination is published on the rerun, not replaced by another key", async () => {
    const first = setup({
      gone: "AKID-0",
      failName: { place: GITHUB, name: "API_KEY_ID" },
      answers: ["y"],
    });
    expect(await first.rotate()).toBe(1);
    expect((await first.state()).issued[0]?.old).toMatchObject({ id: null, revoked: true });

    const rerun = first.again({ answers: ["y"] });
    expect(await rerun.rotate()).toBe(0);
    expect(rerun.issuer.log.slice(2)).toEqual(["check AKID-1"]);
    expect(rerun.writes()).toEqual([`write ${GITHUB} API_KEY_ID (6 chars)`]);
  });

  test("a crash part way through publishing resumes both keys from the record", async () => {
    const first = setup({ failName: { place: GITHUB, name: "API_SECRET" }, answers: ["y"] });
    expect(await first.rotate()).toBe(1);

    const rerun = first.again({ answers: ["y", "y"] });
    expect(await rerun.rotate()).toBe(0);
    expect(rerun.writes()).toEqual([
      `write ${GITHUB} API_SECRET (${NEW(1).length} chars)`,
      `write ${GITHUB} API_KEY_ID (6 chars)`,
    ]);
    expect(rerun.issuer.log.slice(2)).toEqual(["check AKID-1", "revoke AKID-0"]);
  });

  test("a rerun after everything finished creates the next key from the vault's ID", async () => {
    const first = setup({ answers: ["y", "y"] });
    expect(await first.rotate()).toBe(0);
    const next = first.again({ answers: ["y", "y"] });
    expect(await next.rotate()).toBe(0);
    expect(next.issuer.log.slice(3)).toEqual([
      "check AKID-1",
      "create API_SECRET -> AKID-2",
      "revoke AKID-1",
    ]);
  });

  test("a map that moves key_id part way through stops instead of writing the ID elsewhere", async () => {
    const vault = writableVault({ ...VALUES, "other id": "AKID-0" });
    const first = setup({ vault, saves: { "api key id": "refused" }, answers: ["y"] });
    expect(await first.rotate()).toBe(1);
    first.disk.contents.set(
      "/work/billing/keypin.toml",
      `${MAP.replace('key_id = "API_KEY_ID"', 'key_id = "OTHER_ID"')}
[keys.OTHER_ID]
rotate_every = "never"

[keys.OTHER_ID.prod]
from = "op://Private/other id/credential"
${PUBLISH}
`,
    );
    const moved = first.again({ answers: ["y"] });
    expect(await moved.rotate()).toBe(1);
    expect(moved.stderr.text).toContain(
      'Stopped: keypin is part way through rotating API_SECRET with its ID in API_KEY_ID, and the map now names OTHER_ID. To finish, set key_id back to "API_KEY_ID" and run this again. Nothing was created.',
    );
    expect(moved.issuer.log.slice(2)).toEqual([]);
  });

  test("with nothing left to revoke, moving key_id before the ID reached every destination stops instead of creating another key", async () => {
    const vault = writableVault({ ...VALUES, "other id": "AKID-0" });
    const first = setup({
      vault,
      gone: "AKID-0",
      failName: { place: GITHUB, name: "API_KEY_ID" },
      answers: ["y"],
    });
    expect(await first.rotate()).toBe(1);
    first.disk.contents.set(
      "/work/billing/keypin.toml",
      `${MAP.replace('key_id = "API_KEY_ID"', 'key_id = "OTHER_ID"')}
[keys.OTHER_ID]
rotate_every = "never"

[keys.OTHER_ID.prod]
from = "op://Private/other id/credential"
${PUBLISH}
`,
    );
    const moved = first.again({ answers: ["y", "y"] });
    expect(await moved.rotate()).toBe(1);
    expect(moved.stderr.text).toContain(
      "Stopped: keypin is part way through rotating API_SECRET with its ID in API_KEY_ID",
    );
    expect(moved.issuer.log.slice(2)).toEqual([]);
    expect([...moved.issuer.live]).not.toContain("AKID-2");
  });

  test("after a finished rotation, renaming the ID entry lets the next rotation use the new name", async () => {
    const first = setup({ answers: ["y", "y"] });
    expect(await first.rotate()).toBe(0);
    first.disk.contents.set(
      "/work/billing/keypin.toml",
      MAP.replace('key_id = "API_KEY_ID"', 'key_id = "NEW_KEY_ID"').replace(
        /\[keys\.API_KEY_ID(\.prod)?\]/g,
        (m) => m.replace("API_KEY_ID", "NEW_KEY_ID"),
      ),
    );
    const next = first.again({ answers: ["y", "y"] });
    expect(await next.rotate()).toBe(0);
    expect(next.stderr.text).not.toContain("part way through");
    expect(next.issuer.log.slice(3)).toEqual([
      "check AKID-1",
      "create API_SECRET -> AKID-2",
      "revoke AKID-1",
    ]);
  });

  test("keypin rotate on the ID points to the key that rotates it", async () => {
    const run = setup();
    expect(await run.rotate("API_KEY_ID")).toBe(1);
    expect(run.stderr.text).toContain(
      'key "API_KEY_ID" prod holds the ID of API_SECRET, and keypin rotates the two together. Run keypin rotate API_SECRET.',
    );
    expect(run.stderr.text).not.toContain("has no issuer");
  });

  test("an ID kept in a vault that may hold writes for approval is refused before anything is read", async () => {
    const map = `[infisical]\norganization = "acme"\n${MAP.replace(
      'from = "op://Private/api key id/credential"',
      'from = "infisical://api/prod/API_KEY_ID"',
    )}`;
    const run = setup({ map, answers: ["y"] });
    expect(await run.rotate()).toBe(1);
    expect(run.stderr.text).toContain(
      "Infisical may hold a change for approval, which would leave API_SECRET and its ID API_KEY_ID saved apart, so keypin can't rotate them. Rotate both by hand.",
    );
    expect(run.issuer.log).toEqual([]);
    expect(run.vault.log).toEqual([]);
  });

  test("declining creates nothing and writes nothing", async () => {
    const run = setup({ answers: ["n"] });
    expect(await run.rotate()).toBe(NEEDS_APPROVAL);
    expect(run.issuer.log).toEqual(["check AKID-0"]);
    expect(pairOf(run)).toEqual([OLD_SECRET, "AKID-0"]);
  });
});

describe("keypin status: a key whose ID is another key", () => {
  test("the ID entry rotates with its key, and has no rotated date of its own to report", async () => {
    const run = setup();
    run.disk.contents.set(
      "/home/me/.config/keypin/registry.json",
      JSON.stringify({ version: 1, projects: ["/work/billing"] }),
    );
    expect(await cli(["status"], run.deps)).toBe(1);
    const lines = run.stdout.text.split("\n");
    expect(lines.find((l) => l.includes("API_KEY_ID"))).toContain("rotates with API_SECRET");
    expect(run.stdout.text).toContain("API_SECRET (prod): no rotated date");
    expect(run.stdout.text).not.toContain("API_KEY_ID (prod): no rotated date");
  });
});
