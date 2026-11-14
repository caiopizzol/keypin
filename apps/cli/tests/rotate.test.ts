import { describe, expect, test } from "vite-plus/test";
import { generationOf, type Issuer, loadState, Secret, type VaultBackend } from "@keypin/core";
import { cli } from "../src/cli";
import { NEEDS_APPROVAL } from "../src/publishing";
import {
  fakeDeps,
  fakeDestinations,
  type FakeDestinationOptions,
  memoryFiles,
  STATE,
} from "./fakes";

const OLD = "re_old_sentinel_value_4b1c";
const ADMIN = "re_admin_sentinel_value_7e2f";
const NEW = (n: number) => `re_new_sentinel_value_${n}_9a3d`;
const WORKER = "cloudflare-worker:mailer";
const GITHUB = "github-actions:acme/mailer";

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

function writableVault(failSave = false) {
  const values = new Map([
    ["mailer resend key", OLD],
    ["resend admin key", ADMIN],
  ]);
  const rotated: string[] = [];
  const log: string[] = [];
  const made = { count: 0 };
  const vault: VaultBackend = {
    capabilities: { read: true, write: true, list: false, metadata: true },
    async read(ref) {
      log.push(`read ${ref.item}`);
      const value = values.get(ref.item);
      if (value === undefined) throw new Error(`no item "${ref.item}"`);
      return new Secret(value);
    },
    async readItem(ref) {
      return { secret: await vault.read(ref), ids: { vault: "v1", item: `id-${ref.item}` } };
    },
    async itemIds(ref) {
      return { vault: "v1", item: `id-${ref.item}` };
    },
    async write(ref, secret, options = {}) {
      if (failSave) {
        log.push(`save ${ref.item} failed`);
        throw new Error("1Password: the item is locked");
      }
      log.push(`save ${ref.item}`);
      values.set(ref.item, secret.reveal());
      if (options.rotated) rotated.push(options.rotated);
    },
    async list() {
      return [];
    },
    async metadata() {
      return { rotated: null };
    },
  };
  return { vault, values, rotated, log, made };
}

interface Setup extends FakeDestinationOptions, IssuerOptions {
  answers?: string[];
  terminal?: boolean;
  disk?: ReturnType<typeof memoryFiles>;
  vault?: ReturnType<typeof writableVault>;
  failSave?: boolean;
}

function setup(options: Setup = {}) {
  const disk = options.disk ?? memoryFiles({ "/work/billing/keypin.toml": MAP });
  const vault = options.vault ?? writableVault(options.failSave);
  const destinations = fakeDestinations(options);
  const issuer = fakeIssuer(options, vault.made);
  const answers = [...(options.answers ?? [])];
  const asked: string[] = [];
  const fake = fakeDeps({
    disk,
    backend: vault.vault,
    deps: {
      destination: destinations.build,
      issuer: issuer.build,
      isTerminal: options.terminal ?? true,
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
  const state = () => loadState(disk.files, STATE);
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
      "create RESEND_API_KEY prod 2026-11-09 -> key-1",
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
      "create RESEND_API_KEY prod 2026-11-09 -> key-2",
      "revoke key-1",
    ]);
    expect(again.stderr.text).toContain(
      [
        "Plan",
        "  + Resend                   create a new key",
        "  ~ 1Password                save it to op://Private/mailer resend key/credential, rotated today",
        "  ~ Cloudflare  mailer       new value",
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
    expect(run.stderr.text).toContain("Stopped. Nothing was created.");
  });

  test("a failed vault save says to delete the new key, and the rerun creates a fresh one", async () => {
    const vault = writableVault(true);
    const first = setup({ vault, answers: ["y"] });
    expect(await first.run()).toBe(1);
    expect(first.writes()).toEqual([]);
    expect(first.stderr.text).toContain(
      "Stopped: the new key key-1 exists at Resend but isn't in 1Password, and keypin can't show it again. Delete it at https://resend.com/api-keys, then run this again:",
    );
    expect((await first.state()).issued).toEqual([expect.objectContaining({ id: "key-1" })]);
    expect(first.leaked()).toBe(false);

    const fixed = writableVault();
    const again = setup({ disk: first.disk, vault: fixed, answers: ["y", "n"] });
    expect(await again.run()).toBe(0);
    expect(again.stderr.text).toContain(
      `keypin created key key-1 at Resend on ${again.deps.now().toISOString()}, but 1Password doesn't hold it. If nothing uses it, delete it at https://resend.com/api-keys.`,
    );
    expect(fixed.values.get("mailer resend key")).toBe(NEW(1));
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

  test("without a terminal, --yes rotates a routine key but never revokes", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const second = setup({ disk: first.disk, vault: first.vault, terminal: false });
    expect(await second.run("--yes")).toBe(NEEDS_APPROVAL);
    expect(second.issuer.log).toEqual([
      "check key-1",
      "create RESEND_API_KEY prod 2026-11-09 -> key-2",
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

  test("a service account can't save a new key, so nothing is created", async () => {
    const vault = writableVault();
    const readOnly = {
      ...vault,
      vault: { ...vault.vault, capabilities: { ...vault.vault.capabilities, write: false } },
    };
    const run = setup({ vault: readOnly, answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.issuer.log).toEqual([]);
    expect(run.stderr.text).toContain("needs the desktop app");
  });

  test("the new key's generation is what publish records", async () => {
    const run = setup({ answers: ["y"] });
    await run.run();
    const generation = await generationOf(new Secret(NEW(1)));
    expect((await run.state()).receipts.map((r) => r.generation)).toEqual([generation, generation]);
  });
});
