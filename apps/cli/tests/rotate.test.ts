import { describe, expect, test } from "vite-plus/test";
import { type Fetch, generationOf, type Issuer, loadState, Secret } from "@keypin/core";
import { memoryKeys, resendFetch } from "@keypin/connectors/resend/testing";
import { cli } from "../src/cli";
import { issuer as connect, vaults } from "../src/start";
import { NEEDS_APPROVAL } from "../src/approval";
import {
  fakeDeps,
  fakeDestinations,
  type FakeDestinationOptions,
  memoryFiles,
  STATE,
  writableVault,
} from "./fakes";

const OLD = "re_old_sentinel_value_4b1c";
const ADMIN = "re_admin_sentinel_value_7e2f";
const NEW = (n: number) => `re_new_sentinel_value_${n}_9a3d`;
const WORKER = "cloudflare-worker:mailer";
const GITHUB = "github-actions:acme/mailer";

const VALUES = { "mailer resend key": OLD, "resend admin key": ADMIN };

const MAP = `
[1password]
account = "my.1password.com"

[keys.RESEND_API_KEY]
rotate_every = "90d"

[keys.RESEND_API_KEY.prod]
from = "op://Private/mailer resend key/credential"
publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "mailer" },
  { to = "github-actions", repo = "acme/mailer" },
]
issuer = { kind = "resend", admin = "op://Private/resend admin key/credential", permission = "sending_access" }
`;

interface IssuerOptions {
  failCheck?: boolean;
  failCreate?: boolean;
  failRevoke?: boolean;
  listed?: string[];
}

function fakeIssuer(options: IssuerOptions, made: { count: number }) {
  const log: string[] = [];
  const admins: string[] = [];
  const build = (_spec: unknown, admin: Secret): Issuer => {
    admins.push(admin.reveal());
    return {
      describe: () => "Resend",
      dashboard: () => "https://resend.com/api-keys",
      async checkAccount(current) {
        log.push(`check ${current ?? "none"}`);
        if (options.failCheck)
          return {
            ok: false,
            facts: "Resend answered HTTP 401",
            reason: "the admin key can only send emails",
          };
        if (current !== null && options.listed && !options.listed.includes(current))
          return {
            ok: false,
            facts: "the admin key lists 1 API key",
            reason: `Resend doesn't list key ${current}`,
          };
        return { ok: true, facts: "the admin key lists 2 API keys" };
      },
      async create(name) {
        if (options.failCreate) {
          log.push("create failed");
          throw new Error("Resend POST /api-keys returned HTTP 500");
        }
        made.count++;
        log.push(`create ${name} -> key-${made.count}`);
        return { id: `key-${made.count}`, secret: new Secret(NEW(made.count)) };
      },
      async revoke(id) {
        if (options.failRevoke) {
          log.push(`revoke ${id} failed`);
          throw new Error("Resend DELETE /api-keys/<id> returned HTTP 500");
        }
        log.push(`revoke ${id}`);
        return "revoked";
      },
    };
  };
  return { build, log, admins };
}

function resend(options: {
  failCreate?: number;
  loseCreated?: boolean;
  keys?: ReturnType<typeof memoryKeys>;
}) {
  return resendFetch({
    tokenPrefix: "re_new_",
    keys: options.keys ?? memoryKeys(["key-0"]),
    effect: () => undefined,
    ...options,
  });
}

function unwritableState() {
  const disk = memoryFiles({ "/work/billing/keypin.toml": MAP });
  const files = { ...disk.files };
  disk.files.write = async (path, text) => {
    if (path.startsWith(STATE)) throw new Error("EACCES: permission denied");
    return files.write(path, text);
  };
  return disk;
}

interface Setup extends FakeDestinationOptions, IssuerOptions {
  answers?: string[];
  terminal?: boolean;
  disk?: ReturnType<typeof memoryFiles>;
  vault?: ReturnType<typeof writableVault>;
  failSave?: boolean | "refused";
  made?: { count: number };
  serviceAccount?: boolean;
  tag?: string;
  resend?: Fetch;
}

function setup(options: Setup = {}) {
  const disk = options.disk ?? memoryFiles({ "/work/billing/keypin.toml": MAP });
  const vault = options.vault ?? writableVault(VALUES, options.failSave);
  const destinations = fakeDestinations(options);
  const issuer = fakeIssuer(options, options.made ?? vault.made);
  const answers = [...(options.answers ?? [])];
  const asked: string[] = [];
  const fake = fakeDeps({
    disk,
    backend: vault.vault,
    deps: {
      destination: destinations.build,
      issuer: options.resend ? (spec, admin) => connect(spec, admin, options.resend) : issuer.build,
      isTerminal: options.terminal ?? true,
      ...(options.tag ? { tag: () => options.tag ?? "" } : {}),
      ...(options.serviceAccount
        ? { signIn: () => ({ mode: "service-account", address: "my.1password.com" }) }
        : {}),
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
    },
  });
  const run = (...args: string[]) => cli(["rotate", "RESEND_API_KEY", ...args], fake.deps);
  const writes = () => destinations.log.filter((l) => l.startsWith("write"));
  const everything = () =>
    [fake.stdout.text, fake.stderr.text, ...disk.contents.values()].join("\n");
  const leaked = () => [OLD, ADMIN, NEW(1), NEW(2)].some((v) => everything().includes(v));
  const state = () => loadState(disk.files, STATE, vaults);
  return { ...fake, disk, vault, issuer, destinations, asked, run, writes, leaked, state };
}

describe("keypin rotate", () => {
  test("creates, saves, publishes, then revokes the old key after a second y", async () => {
    const before = setup({ answers: ["y", "y"] });
    expect(await before.run()).toBe(0);
    expect(before.asked).toEqual(["Rotate RESEND_API_KEY? [y/N] "]);
    expect(before.issuer.admins).toEqual([ADMIN]);
    expect(before.issuer.log).toEqual([
      "check none",
      "create RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3 -> key-1",
    ]);
    expect(before.vault.values.get("mailer resend key")).toBe(NEW(1));
    expect(before.vault.rotated).toEqual(["2026-11-09"]);
    expect(before.writes()).toEqual([
      `write ${WORKER} RESEND_API_KEY (${NEW(1).length} chars)`,
      `write ${GITHUB} RESEND_API_KEY (${NEW(1).length} chars)`,
    ]);
    expect(before.stderr.text).toContain(
      "keypin doesn't know which key at Resend it replaced. Once nothing uses the old one, delete it at https://resend.com/api-keys.",
    );
    expect(before.leaked()).toBe(false);

    const again = setup({ disk: before.disk, vault: before.vault, answers: ["y", "y"] });
    expect(await again.run()).toBe(0);
    expect(again.asked).toEqual([
      "Rotate RESEND_API_KEY? [y/N] ",
      "Revoke the old key at Resend? [y/N] ",
    ]);
    expect(again.issuer.log).toEqual([
      "check key-1",
      "create RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3 -> key-2",
      "revoke key-1",
    ]);
    expect(again.stderr.text).toContain(
      [
        "Plan",
        "  + Resend                   create a new key",
        "  ~ 1Password                save it to op://Private/mailer resend key/credential, rotated today",
        "  ~ Cloudflare  mailer       new value",
        "    writing a Worker secret deploys a new version of the Worker",
        "  ~ GitHub      acme/mailer  new value",
        "  - Resend                   revoke the old key key-1, after a second y",
      ].join("\n"),
    );
    const state = await again.state();
    expect(state.issued).toEqual([
      expect.objectContaining({
        id: "key-2",
        old: { id: "key-1", generation: await generationOf(new Secret(NEW(1))), revoked: true },
      }),
    ]);
    expect(again.vault.values.get("mailer resend key")).toBe(NEW(2));
    expect(again.leaked()).toBe(false);
  });

  test("declining the revoke exits 0, keeps the old key, and says how to revoke it later", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const second = setup({ disk: first.disk, vault: first.vault, answers: ["y", "n"] });
    expect(await second.run()).toBe(0);
    expect(second.issuer.log.some((l) => l.startsWith("revoke"))).toBe(false);
    expect(second.stderr.text).toContain(
      "The old key key-1 still works. Revoke it once nothing uses it.\nTo revoke it later, run this in a terminal:\n  cd /work/billing && /opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts rotate RESEND_API_KEY\n",
    );

    const later = setup({ disk: first.disk, vault: first.vault, answers: ["y"] });
    expect(await later.run()).toBe(0);
    expect(later.asked).toEqual(["Revoke the old key at Resend? [y/N] "]);
    expect(later.stderr.text).toContain("Resuming: keypin created key key-2");
    expect(later.issuer.log).toEqual(["check key-2", "revoke key-1"]);
    expect(later.writes()).toEqual([]);
  });

  test("an issuer account check that fails stops before anything is created", async () => {
    const run = setup({ failCheck: true, answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.asked).toEqual([]);
    expect(run.issuer.log).toEqual(["check none"]);
    expect(run.stderr.text).toContain("    the admin key can only send emails");
    expect(run.stderr.text).toContain(
      "Stopped: an account check failed. Nothing was created and nothing was written.",
    );
  });

  test("a destination account check that fails stops before anything is created", async () => {
    const run = setup({ badAccount: [GITHUB], answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.asked).toEqual([]);
    expect(run.issuer.log).toEqual(["check none"]);
  });

  test("declining the rotation creates nothing", async () => {
    const run = setup({ answers: ["n"] });
    expect(await run.run()).toBe(NEEDS_APPROVAL);
    expect(run.issuer.log).toEqual(["check none"]);
    expect(run.stderr.text).toContain("Not confirmed. Nothing was created.");
    expect(run.disk.contents.has(STATE)).toBe(false);
  });

  test("a failed create stops, and the vault still holds the old key", async () => {
    const run = setup({ failCreate: true, answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.vault.values.get("mailer resend key")).toBe(OLD);
    expect(run.writes()).toEqual([]);
    expect(run.stderr.text).toContain("Resend POST /api-keys returned HTTP 500");
  });

  test("a create Resend refuses says nothing was created", async () => {
    const run = setup({ answers: ["y"], resend: resend({ failCreate: 422 }) });
    expect(await run.run()).toBe(1);
    expect(run.stderr.text).toContain("Resend POST /api-keys returned HTTP 422");
    expect(run.stderr.text).toContain("Stopped. Nothing was created.");
  });

  test("a create whose reply is lost names the key to delete, and doesn't say nothing was created", async () => {
    const keys = memoryKeys(["key-0"]);
    const run = setup({ answers: ["y"], resend: resend({ loseCreated: true, keys }) });
    expect(await run.run()).toBe(1);
    expect(keys.load().live).toEqual(["key-0", "re-new-1"]);
    expect(run.stderr.text).not.toContain("Nothing was created");
    expect(run.stderr.text).toContain(
      'Stopped: keypin didn\'t get the new key back. Resend may have made the key before the reply was lost. Only this run uses the name "RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3": delete a key with that name at https://resend.com/api-keys before you run this again, or the rerun leaves it live.',
    );
    expect(run.vault.values.get("mailer resend key")).toBe(OLD);
  });

  test("two machines rotating in the same second send different names", async () => {
    const first = setup({ answers: ["y"], tag: "aaaaaa", failCreate: true });
    const second = setup({ answers: ["y"], tag: "bbbbbb", failCreate: true });
    await first.run();
    await second.run();
    expect(first.stderr.text).toContain('"RESEND_API_KEY prod 2026-11-09 12:00:00 aaaaaa"');
    expect(second.stderr.text).toContain('"RESEND_API_KEY prod 2026-11-09 12:00:00 bbbbbb"');
  });

  test("a create that fails at Resend's end gives the same advice", async () => {
    const run = setup({ answers: ["y"], resend: resend({ failCreate: 503 }) });
    expect(await run.run()).toBe(1);
    expect(run.stderr.text).not.toContain("Nothing was created");
    expect(run.stderr.text).toContain(
      'Only this run uses the name "RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3": delete a key with that name at https://resend.com/api-keys before you run this again',
    );
  });

  test("an issuer without its own advice says a key may exist and where to delete it", async () => {
    const run = setup({ failCreate: true, answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.stderr.text).not.toContain("Nothing was created");
    expect(run.stderr.text).toContain(
      'Stopped: keypin didn\'t get the new key back. Resend may have made the new key before this failed. Delete any key named "RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3" at https://resend.com/api-keys before you run this again.',
    );
  });

  test("a failed vault save says to delete the new key, and the rerun creates a fresh one", async () => {
    const vault = writableVault(VALUES, true);
    const first = setup({ vault, answers: ["y"] });
    expect(await first.run()).toBe(1);
    expect(first.writes()).toEqual([]);
    expect(first.stderr.text).toContain(
      "Stopped: the new key key-1 exists at Resend but isn't in 1Password, and keypin can't show it again. Delete it at https://resend.com/api-keys, then run this again:",
    );
    expect((await first.state()).issued).toEqual([expect.objectContaining({ id: "key-1" })]);
    expect(first.leaked()).toBe(false);

    const fixed = writableVault(VALUES);
    const again = setup({ disk: first.disk, vault: fixed, made: vault.made, answers: ["y", "n"] });
    expect(await again.run()).toBe(0);
    expect(again.stderr.text).toContain(
      `keypin created key key-1 at Resend on ${again.deps.now().toISOString()}, but 1Password doesn't hold it. If nothing uses it, delete it at https://resend.com/api-keys.`,
    );
    expect(again.issuer.log).toEqual([
      "check none",
      "create RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3 -> key-2",
    ]);
    expect(fixed.values.get("mailer resend key")).toBe(NEW(2));
    expect((await again.state()).issued).toEqual([expect.objectContaining({ id: "key-2" })]);
  });

  test("a state file that can't be written revokes the new key and saves nothing", async () => {
    const disk = unwritableState();
    const run = setup({ disk, answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.issuer.log).toEqual([
      "check none",
      "create RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3 -> key-1",
      "revoke key-1",
    ]);
    expect(run.vault.log.some((l) => l.startsWith("save"))).toBe(false);
    expect(run.vault.values.get("mailer resend key")).toBe(OLD);
    expect(run.writes()).toEqual([]);
    expect(run.stderr.text).toContain(
      `Stopped: couldn't record the new key in ${STATE}: EACCES: permission denied. Revoked it at Resend. Nothing changed.`,
    );
  });

  test("a state file that can't be written and a failed revoke name the key to delete", async () => {
    const disk = unwritableState();
    const run = setup({ disk, failRevoke: true, answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.issuer.log).toContain("revoke key-1 failed");
    expect(run.vault.log.some((l) => l.startsWith("save"))).toBe(false);
    expect(run.stderr.text).toContain(
      `Stopped: couldn't record the new key in ${STATE}: EACCES: permission denied. keypin couldn't revoke it either: delete key key-1 at https://resend.com/api-keys. The old key still works.`,
    );
  });

  test("a key another issuer made is reported at that issuer, not the configured one", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const state = await first.state();
    const stale = state.issued.map((i) => ({
      ...i,
      issuer: "openai",
      generation: "cccccccccccccccc",
    }));
    first.disk.contents.set(STATE, JSON.stringify({ ...state, issued: stale }));
    const again = setup({ disk: first.disk, vault: first.vault, answers: ["n"] });
    expect(await again.run()).toBe(NEEDS_APPROVAL);
    expect(again.stderr.text).toContain(
      `keypin created key key-1 at openai on ${again.deps.now().toISOString()}, before this key's issuer became Resend. If nothing uses it, delete it at openai, not Resend.`,
    );
    expect(again.stderr.text).not.toContain("delete it at https://resend.com/api-keys");
  });

  test("a failed destination keeps the new key, never revokes, and the rerun finishes without creating another", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const failing = setup({
      disk: first.disk,
      vault: first.vault,
      failWrite: [GITHUB],
      answers: ["y", "y"],
    });
    expect(await failing.run()).toBe(1);
    expect(failing.asked).toEqual(["Rotate RESEND_API_KEY? [y/N] "]);
    expect(failing.issuer.log.some((l) => l.startsWith("revoke"))).toBe(false);
    expect(failing.vault.values.get("mailer resend key")).toBe(NEW(2));
    expect(failing.stderr.text).toContain(
      "Stopped. The new key is in 1Password, and the old key still works. To continue, run:\n  cd /work/billing && ",
    );

    const resumed = setup({ disk: first.disk, vault: first.vault, answers: ["y", "y"] });
    expect(await resumed.run()).toBe(0);
    expect(resumed.stderr.text).toContain("Resuming: keypin created key key-2 at Resend");
    expect(resumed.stderr.text).toContain("= Cloudflare  mailer       already has this value");
    expect(resumed.issuer.log).toEqual(["check key-2", "revoke key-1"]);
    expect(resumed.writes()).toEqual([`write ${GITHUB} RESEND_API_KEY (${NEW(2).length} chars)`]);
    expect(resumed.asked).toEqual([
      "Write 1 secret? [y/N] ",
      "Revoke the old key at Resend? [y/N] ",
    ]);
    expect(resumed.leaked()).toBe(false);
  });

  test("without a terminal, a first write stops before reading anything", async () => {
    const run = setup({ terminal: false });
    expect(await run.run("--yes")).toBe(NEEDS_APPROVAL);
    expect(run.vault.log).toEqual([]);
    expect(run.issuer.log).toEqual([]);
    expect(run.stderr.text).toContain("this rotation needs approval, and --yes can't give it");
  });

  test("without a terminal, an item replaced under the same title stops before reading either key", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    first.vault.itemIds.set("mailer resend key", "id-replaced");
    first.vault.log.length = 0;
    const run = setup({ disk: first.disk, vault: first.vault, terminal: false });
    expect(await run.run("--yes")).toBe(NEEDS_APPROVAL);
    expect(run.vault.log).toEqual(["ids mailer resend key"]);
    expect(run.issuer.admins).toEqual([]);
    expect(run.issuer.log).toEqual([]);
    expect(run.stderr.text).toContain(
      "was last published from op://Private/mailer resend key/credential",
    );
    expect(run.stderr.text).toContain("Nothing was read and nothing was created.");
  });

  test("a destination that left the map is named in the plan and again before the revoke", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    first.disk.contents.set(
      "/work/billing/keypin.toml",
      MAP.replace('  { to = "github-actions", repo = "acme/mailer" },\n', ""),
    );
    const run = setup({ disk: first.disk, vault: first.vault, answers: ["y", "n"] });
    expect(await run.run()).toBe(0);
    expect(run.writes()).toEqual([`write ${WORKER} RESEND_API_KEY (${NEW(2).length} chars)`]);
    const gone = `- ${GITHUB}:RESEND_API_KEY: not in the map any more (last got ${await generationOf(new Secret(NEW(1)))}`;
    expect(run.stderr.text.split(gone)).toHaveLength(3);
    expect(run.stderr.text).toContain(
      "Rotated RESEND_API_KEY (prod): the new key is in 1Password and the destination in the map.\nNot in the map any more, so keypin didn't write them; they may still use the old key:\n",
    );
    expect(run.stderr.text).not.toContain("every destination");
    expect(run.stderr.text.indexOf(gone, run.stderr.text.indexOf("Rotated"))).toBeLessThan(
      run.stderr.text.indexOf("The old key key-1 still works"),
    );
  });

  test("without a terminal, --yes rotates a routine key but never revokes", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const second = setup({ disk: first.disk, vault: first.vault, terminal: false });
    expect(await second.run("--yes")).toBe(NEEDS_APPROVAL);
    expect(second.issuer.log).toEqual([
      "check key-1",
      "create RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3 -> key-2",
    ]);
    expect(second.writes()).toHaveLength(2);
    expect(second.stderr.text).toContain(
      "The old key key-1 still works. Revoking it needs a y in a terminal.",
    );

    const plain = setup({ disk: first.disk, vault: first.vault, terminal: false });
    expect(await plain.run()).toBe(NEEDS_APPROVAL);
    expect(plain.issuer.log).toEqual(["check key-2"]);
    expect(plain.issuer.log.some((l) => l.startsWith("revoke"))).toBe(false);
  });

  test("a key the admin key can't see stops: another team, or deleted", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const run = setup({ disk: first.disk, vault: first.vault, listed: [], answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.stderr.text).toContain("Resend doesn't list key key-1");
    expect(run.issuer.log).toEqual(["check key-1"]);
  });

  test("a failed revoke says the old key may still work and how to retry", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const run = setup({
      disk: first.disk,
      vault: first.vault,
      failRevoke: true,
      answers: ["y", "y"],
    });
    expect(await run.run()).toBe(1);
    expect(run.stderr.text).toContain(
      "Stopped: the old key key-1 may still work. To try again, run:",
    );
    const retry = setup({ disk: first.disk, vault: first.vault, answers: ["y"] });
    expect(await retry.run()).toBe(0);
    expect(retry.issuer.log).toEqual(["check key-2", "revoke key-1"]);
  });

  test("a key without an issuer says how to add one", async () => {
    const run = setup();
    run.disk.contents.set("/work/billing/keypin.toml", MAP.replace(/\nissuer = .*\n/, "\n"));
    expect(await run.run()).toBe(1);
    expect(run.stderr.text).toContain(
      'key "RESEND_API_KEY" prod has no issuer in /work/billing/keypin.toml, so keypin can\'t make a new key. Add one (see docs/configuration.md), or rotate it by hand.',
    );
  });

  test("a service account creates the new key and saves it to 1Password", async () => {
    const run = setup({ serviceAccount: true, answers: ["y", "y"] });
    expect(await run.run()).toBe(0);
    expect(run.issuer.log).toEqual([
      "check none",
      "create RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3 -> key-1",
    ]);
    expect(run.vault.values.get("mailer resend key")).toBe(NEW(1));
    expect(run.vault.rotated).toEqual(["2026-11-09"]);
    expect(run.stderr.text).not.toContain("desktop app");
  });

  test("a service account without write access revokes the key it just created", async () => {
    const run = setup({ serviceAccount: true, failSave: "refused", answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.issuer.log).toEqual([
      "check none",
      "create RESEND_API_KEY prod 2026-11-09 12:00:00 a1b2c3 -> key-1",
      "revoke key-1",
    ]);
    expect(run.writes()).toEqual([]);
    expect(run.stderr.text).toContain(
      "Stopped: 1Password refused to save the new key. Revoked it at Resend. Nothing changed.",
    );
    expect((await run.state()).issued).toEqual([]);
    expect(run.leaked()).toBe(false);
  });

  test("a service account's plan says nothing about another machine", async () => {
    const run = setup({ serviceAccount: true });
    expect(await run.run("--plan")).toBe(NEEDS_APPROVAL);
    expect(run.stderr.text).not.toContain("Rotating needs another machine");
    expect(run.stderr.text).toContain("  + Resend                   create a new key");
  });

  test("a service account finishes a saved rotation: publish and revoke", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const failing = setup({
      disk: first.disk,
      vault: first.vault,
      failWrite: [GITHUB],
      answers: ["y"],
    });
    expect(await failing.run()).toBe(1);
    const resumed = setup({
      disk: first.disk,
      vault: first.vault,
      serviceAccount: true,
      answers: ["y", "y"],
    });
    expect(await resumed.run()).toBe(0);
    expect(resumed.writes()).toEqual([`write ${GITHUB} RESEND_API_KEY (${NEW(2).length} chars)`]);
    expect(resumed.issuer.log).toEqual(["check key-2", "revoke key-1"]);
  });

  test("--plan runs the checks, shows the plan, and creates, writes and asks nothing", async () => {
    const run = setup({ terminal: false });
    expect(await run.run("--plan", "--yes")).toBe(NEEDS_APPROVAL);
    expect(run.asked).toEqual([]);
    expect(run.issuer.log).toEqual(["check none"]);
    expect(run.destinations.log.filter((l) => l.startsWith("check")).toSorted()).toEqual([
      `check ${WORKER}`,
      `check ${GITHUB}`,
    ]);
    expect(run.vault.log.some((l) => l.startsWith("save"))).toBe(false);
    expect(run.vault.values.get("mailer resend key")).toBe(OLD);
    expect(run.writes()).toEqual([]);
    expect(run.disk.contents.has(STATE)).toBe(false);
    expect(run.stderr.text).toContain(
      [
        "Plan",
        "  + Resend                   create a new key",
        "  ~ 1Password                save it to op://Private/mailer resend key/credential, rotated today",
        "  + Cloudflare  mailer       first write  needs approval",
        "    writing a Worker secret deploys a new version of the Worker",
        "  + GitHub      acme/mailer  first write  needs approval",
        "  - Resend                   the old key stays: keypin doesn't know its ID",
        "",
        "This plan needs approval in a terminal; --yes can't give it.",
        "Nothing was written: --plan only shows the plan.",
        "To approve, run this in a terminal:",
        "  cd /work/billing && /opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts rotate RESEND_API_KEY --yes",
      ].join("\n"),
    );
    expect(run.leaked()).toBe(false);
  });

  test("--plan on a resumed rotation shows the rest, revokes nothing and writes nothing", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const failing = setup({
      disk: first.disk,
      vault: first.vault,
      failWrite: [GITHUB],
      answers: ["y"],
    });
    expect(await failing.run()).toBe(1);
    const saved = first.disk.contents.get(STATE);

    const plan = setup({ disk: first.disk, vault: first.vault, answers: ["y", "y"] });
    expect(await plan.run("--plan")).toBe(NEEDS_APPROVAL);
    expect(plan.asked).toEqual([]);
    expect(plan.issuer.log).toEqual(["check key-2"]);
    expect(plan.writes()).toEqual([]);
    expect(plan.disk.contents.get(STATE)).toBe(saved);
    expect(plan.stderr.text).toContain(
      [
        "Plan",
        "  = Cloudflare  mailer       already has this value",
        "  ~ GitHub      acme/mailer  new value",
        "  - Resend                   revoke the old key key-1, after a second y",
        "",
        "This plan is routine: --yes can approve it.",
      ].join("\n"),
    );

    const published = setup({ disk: first.disk, vault: first.vault, answers: ["y", "n"] });
    expect(await published.run()).toBe(0);
    const left = first.disk.contents.get(STATE);
    const revoke = setup({ disk: first.disk, vault: first.vault, answers: ["y"] });
    expect(await revoke.run("--plan")).toBe(NEEDS_APPROVAL);
    expect(revoke.asked).toEqual([]);
    expect(revoke.issuer.log).toEqual(["check key-2"]);
    expect(revoke.disk.contents.get(STATE)).toBe(left);
    expect(revoke.stderr.text).toContain(
      "  - Resend                   revoke the old key key-1, after a y\n\nThis plan needs approval in a terminal; --yes can't give it.",
    );
  });

  test("the new key's generation is what publish records", async () => {
    const run = setup({ answers: ["y"] });
    await run.run();
    const generation = await generationOf(new Secret(NEW(1)));
    expect((await run.state()).receipts.map((r) => r.generation)).toEqual([generation, generation]);
  });
});
