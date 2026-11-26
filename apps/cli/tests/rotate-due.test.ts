import { assert, describe, expect, test } from "vite-plus/test";
import { isRecord, type KeyRef, type VaultBackend } from "@keypin/core";
import { day } from "@keypin/core/testing";
import { GitHubSecretDestination } from "@keypin/connectors/github";
import { type FakeGitHub, githubFetch } from "@keypin/connectors/github/testing";
import { onePasswordBackend, onePasswordRef } from "@keypin/connectors/onepassword";
import { fakeOnePassword, field, item } from "@keypin/connectors/onepassword/testing";
import { memoryKeys, resendFetch } from "@keypin/connectors/resend/testing";
import { cli } from "../src/cli";
import { NEEDS_APPROVAL } from "../src/approval";
import type { Deps } from "../src/deps";
import { issuer as connect, vaults } from "../src/start";
import { fakeDeps, memoryFiles, parseJson, writableVault } from "./fakes";
import { recording } from "./recording";

const OLD = "re_old_sentinel_value_4b1c";
const ADMIN = "re_admin_sentinel_value_7e2f";
const ITEM = "mailer resend key";
const MAP_FILE = "/work/billing/secretspec.toml";
const ROTATION = "/work/billing/.keypin/rotation.json";
const STATUS = "/work/billing/.keypin/status.json";
const DESTINATION = "github-actions:acme/mailer:RESEND_API_KEY";
const WEB = "github-actions:acme/web:RESEND_API_KEY";
const RERUN =
  "cd /work/billing && /opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts";

const MAP = `
[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
RESEND_API_KEY = { description = "RESEND_API_KEY", ref = { item = "${ITEM}", field = "credential" } }
STRIPE_KEY = { description = "STRIPE_KEY", ref = { item = "stripe key", field = "credential" } }

[tool.keypin.prod.RESEND_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/mailer" }]
issuer = { kind = "resend", admin = "op://Private/resend admin key/credential", permission = "sending_access" }

[tool.keypin.prod.STRIPE_KEY]
rotate_every = "30d"
publish = [{ to = "github-actions", repo = "acme/mailer" }]
`;

const TWO_REPOS = MAP.replace(
  'publish = [{ to = "github-actions", repo = "acme/mailer" }]\nissuer',
  'publish = [{ to = "github-actions", repo = "acme/mailer" }, { to = "github-actions", repo = "acme/web" }]\nissuer',
);

async function world(map = MAP) {
  const keys = memoryKeys(["key-0"]);
  const effects: string[] = [];
  const known: Record<string, string> = { [OLD]: "key-0" };
  const resend = resendFetch({
    admin: ADMIN,
    known,
    tokenPrefix: "re_new_",
    keys,
    effect: (line) => effects.push(line),
  });
  const gh: FakeGitHub = {
    login: "acme-bot",
    repos: {
      "acme/mailer": { owner: "acme", push: true },
      "acme/web": { owner: "acme", push: true },
    },
  };
  const github = await githubFetch(gh);
  const inner = writableVault({ [ITEM]: OLD, "resend admin key": ADMIN, "stripe key": "sk_x" });
  const dates = new Map([[ITEM, "2026-08-01"]]);
  const item = (ref: KeyRef) => onePasswordRef(ref)?.item ?? "";
  const vault: VaultBackend = {
    ...inner.vault,
    async write(ref, secret, options) {
      await inner.vault.write(ref, secret, options);
      if (options?.rotated) dates.set(item(ref), options.rotated);
    },
    async metadata(ref) {
      const found = dates.get(item(ref));
      return { rotated: found === undefined ? null : day(found) };
    },
  };
  const repo = memoryFiles({ [MAP_FILE]: map });
  const value = () => inner.values.get(ITEM) ?? "";
  return { keys, effects, resend, gh, github, vault, dates, value, repo, inner, known };
}

type World = Awaited<ReturnType<typeof world>>;

function machine(
  w: World,
  options: {
    terminal?: boolean;
    answers?: string[];
    runner?: boolean;
    vaults?: Deps["vaults"];
    token?: string;
  } = {},
) {
  const disk = memoryFiles();
  const answers = [...(options.answers ?? [])];
  const fake = fakeDeps({
    disk,
    backend: w.vault,
    deps: {
      isTerminal: options.terminal ?? false,
      ...(options.runner === false ? { warnRunner: () => false } : {}),
      ...(options.vaults ? { vaults: options.vaults } : {}),
      ask: async () => answers.shift() ?? "",
      issuer: (spec, admin) => connect(spec, admin, w.resend),
      destination: (target) =>
        new GitHubSecretDestination({
          repo: String(target.repo),
          token: async () => options.token ?? "fake-gh-token",
          fetch: w.github.fetch,
        }),
    },
  });
  const run = async (...argv: string[]) => {
    for (const [path, text] of w.repo.contents) disk.contents.set(path, text);
    const code = await cli(["rotate", ...argv], fake.deps);
    for (const path of [ROTATION, STATUS]) {
      const text = disk.contents.get(path);
      if (text !== undefined) w.repo.contents.set(path, text);
    }
    return code;
  };
  return { ...fake, disk, run };
}

const ci = (w: World) => machine(w);
const WARNING =
  "An old key waits for approval: The old RESEND_API_KEY (prod) still works. Once nothing uses it, run this in a checkout with the latest .keypin/rotation.json: keypin rotate RESEND_API_KEY --approve-revoke";
const json = (w: World, path: string) => parseJson(w.repo.contents.get(path) ?? "null");

async function rotatedOnceOnALaptop(map = MAP) {
  const w = await world(map);
  const laptop = machine(w, { terminal: true, answers: ["y"] });
  expect(await laptop.run("--due")).toBe(0);
  expect(laptop.stderr.text).toContain("keypin doesn't know which key at Resend it replaced.");
  expect(w.effects).toEqual(["resend create re-new-1"]);
  w.dates.set(ITEM, "2026-08-01");
  return w;
}

describe("keypin rotate --due without a terminal, Resend to GitHub Actions", () => {
  test("a key with an issuer and no destination is checked, rotated, and its old key waits", async () => {
    const vaultOnly = MAP.replace(
      'publish = [{ to = "github-actions", repo = "acme/mailer" }]\nissuer',
      "issuer",
    );
    expect(vaultOnly).not.toContain(
      'publish = [{ to = "github-actions", repo = "acme/mailer" }]\nissuer',
    );
    const w = await rotatedOnceOnALaptop(vaultOnly);
    const check = ci(w);
    expect(await check.run("--check"), check.stderr.text).toBe(0);
    expect(check.stderr.text).toContain("RESEND_API_KEY  check");

    const run = ci(w);
    expect(await run.run("--due", "--yes"), run.stderr.text).toBe(0);
    expect(run.stderr.text).toContain("RESEND_API_KEY  rotate  was due 2026-10-30");
    expect(run.stderr.text).toContain(
      "The old key re-new-1 still works, and waits for approval.\n",
    );
    expect(run.warnings).toEqual([WARNING]);
    expect(w.effects).toEqual(["resend create re-new-1", "resend create re-new-2"]);
    expect(w.github.value("acme/mailer", "RESEND_API_KEY")).toBeUndefined();
  });

  test("rotates a due key and stops before revoking; --approve-revoke on another fresh runner revokes it", async () => {
    const w = await rotatedOnceOnALaptop();
    const first = ci(w);
    expect(await first.run("--due", "--yes"), "waiting is not a failure").toBe(0);
    expect(first.warnings).toEqual([WARNING]);
    expect(w.effects).toEqual(["resend create re-new-1", "resend create re-new-2"]);
    expect(w.github.value("acme/mailer", "RESEND_API_KEY")).toBe(w.value());
    expect(w.keys.load().live).toEqual(["key-0", "re-new-1", "re-new-2"]);
    expect(first.stderr.text).toContain("RESEND_API_KEY  rotate  was due 2026-10-30");
    expect(first.stderr.text).toContain(
      "STRIPE_KEY      skip    no issuer, so keypin can't make a new key",
    );
    expect(first.stderr.text).toContain(
      "- Resend               revoke the old key re-new-1, after approval",
    );
    expect(first.stderr.text).toContain(
      "The old key re-new-1 still works, and waits for approval.\n",
    );
    expect(first.stderr.text, "the runner warning says how to approve").not.toContain(
      "--approve-revoke",
    );
    expect(json(w, ROTATION)).toMatchObject({
      version: 1,
      issued: [
        {
          key: "RESEND_API_KEY",
          environment: "prod",
          issuer: "resend",
          id: "re-new-2",
          old: { id: "re-new-1", revoked: false },
        },
      ],
      published: [{ key: "RESEND_API_KEY", environment: "prod", destination: DESTINATION }],
    });
    expect(json(w, STATUS)).toMatchObject({
      keys: {
        RESEND_API_KEY: {
          prod: {
            rotated: "2026-11-09",
            rotation: {
              published: ["github-actions:acme/mailer"],
              unpublished: [],
              old: "waiting for approval",
            },
          },
        },
        STRIPE_KEY: { prod: { rotated: null } },
      },
    });

    const again = ci(w);
    expect(await again.run("--due", "--yes")).toBe(0);
    expect(again.warnings).toEqual([WARNING]);
    expect(again.stderr.text).toContain(
      "RESEND_API_KEY  wait  rotated 2026-11-09, the old key waits",
    );
    expect(again.stderr.text).toContain("Nothing is due. An old key waits for approval.");
    expect(w.effects).toHaveLength(2);

    const approve = ci(w);
    expect(await approve.run("--approve-revoke")).toBe(0);
    expect(w.effects).toEqual([
      "resend create re-new-1",
      "resend create re-new-2",
      "resend revoke re-new-1",
    ]);
    expect(json(w, ROTATION)).toMatchObject({
      issued: [{ id: "re-new-2", old: { id: "re-new-1", revoked: true } }],
    });
    expect(json(w, STATUS)).toMatchObject({
      keys: { RESEND_API_KEY: { prod: { rotation: { old: "revoked" } } } },
    });

    const later = ci(w);
    expect(await later.run("--due", "--yes")).toBe(0);
    expect(later.stderr.text).toContain("RESEND_API_KEY  skip  not due until 2027-02-07");
    expect(later.warnings).toEqual([]);
    expect(await later.run("--approve-revoke")).toBe(0);
    expect(later.stderr.text).toContain("No old key waits for approval in prod.");
    expect(w.effects).toHaveLength(3);

    const committed = [w.repo.contents.get(ROTATION), w.repo.contents.get(STATUS)].join("\n");
    expect(committed).not.toMatch(
      /op:|Private|mailer resend|my\.1password|\/work|acme-bot|id-|sk_x/,
    );
    const printed = [first.stderr.text, approve.stderr.text, committed].join("\n");
    for (const value of [OLD, ADMIN, w.value()]) expect(printed).not.toContain(value);
  });

  test("a GitHub App installation token publishes the new key, though GitHub has no user for it", async () => {
    const w = await rotatedOnceOnALaptop();
    w.gh.app = true;
    const run = machine(w, { token: "ghs_fake-installation-token" });
    expect(await run.run("--due", "--yes"), run.stderr.text).toBe(0);
    expect(w.github.value("acme/mailer", "RESEND_API_KEY")).toBe(w.value());
    expect(run.stderr.text).toContain("GitHub  acme/mailer  as the GitHub App, account acme\n");
  });

  test("a finished rotation with no proof needs a person's answer before keypin creates a key", async () => {
    const w = await rotatedOnceOnALaptop();
    const file = parseJson(w.repo.contents.get(ROTATION) ?? "null");
    assert(isRecord(file) && Array.isArray(file.issued));
    for (const issued of file.issued) if (isRecord(issued)) delete issued.proof;
    w.repo.contents.set(ROTATION, `${JSON.stringify(file, null, 2)}\n`);
    const why =
      ".keypin/rotation.json records key re-new-1 for the vault's value without a proof, and Resend can't confirm which key the vault holds, so a person checks this plan in a terminal before keypin creates a key.";

    const run = ci(w);
    expect(await run.run("--due", "--yes")).toBe(NEEDS_APPROVAL);
    expect(run.stderr.text).toContain(why);
    expect(run.stderr.text).toContain(
      "Stopped: this plan needs approval, and --yes can't give it. Nothing was created.",
    );
    const plan = ci(w);
    await plan.run("--due", "--plan");
    expect(plan.stderr.text).toContain(
      "This plan needs approval in a terminal; --yes can't give it.",
    );
    const check = machine(w, { terminal: true });
    expect(await check.run("--check")).toBe(1);
    expect(check.stderr.text).toContain(why);
    const declined = machine(w, { terminal: true, answers: ["n"] });
    expect(await declined.run("--due", "--yes")).toBe(NEEDS_APPROVAL);
    expect(w.effects).toEqual(["resend create re-new-1"]);

    const person = machine(w, { terminal: true, answers: ["y"] });
    expect(await person.run("--due", "--yes")).toBe(0);
    expect(w.effects).toEqual(["resend create re-new-1", "resend create re-new-2"]);
  });

  test("outside GitHub Actions, the waiting old key comes with the command that approves it", async () => {
    const w = await rotatedOnceOnALaptop();
    const cron = machine(w, { runner: false });
    expect(await cron.run("--due", "--yes")).toBe(0);
    const approve = `Once nothing uses the old RESEND_API_KEY (prod), run:\n  ${RERUN} rotate RESEND_API_KEY --approve-revoke`;
    expect(cron.stderr.text).toContain(
      `The old key re-new-1 still works, and waits for approval.\n${approve}`,
    );

    const again = machine(w, { runner: false });
    expect(await again.run("--due", "--yes")).toBe(0);
    expect(again.stderr.text).toContain(
      `Nothing is due. An old key waits for approval.\n${approve}`,
    );
  });

  test("--approve-revoke refuses while a destination lacks the new key; the next --due finishes from .keypin/ alone", async () => {
    const w = await rotatedOnceOnALaptop();
    w.gh.failPut = true;
    expect(await ci(w).run("--due", "--yes")).toBe(1);
    expect(json(w, STATUS)).toMatchObject({
      keys: {
        RESEND_API_KEY: {
          prod: {
            rotation: {
              published: [],
              unpublished: ["github-actions:acme/mailer"],
              old: "still in use",
            },
          },
        },
      },
    });

    const refused = ci(w);
    expect(await refused.run("--approve-revoke")).toBe(1);
    expect(refused.stderr.text).toContain(
      "Stopped: not every destination has the new RESEND_API_KEY (prod) yet, so keypin won't revoke the old key. Run keypin rotate --due first. Nothing was revoked.",
    );
    expect(await refused.run("--approve-revoke", "RESEND_API_KEY")).toBe(1);
    expect(w.effects).toEqual(["resend create re-new-1", "resend create re-new-2"]);

    w.gh.failPut = false;
    const finish = ci(w);
    expect(await finish.run("--due", "--yes")).toBe(0);
    expect(finish.stderr.text).toContain(
      "RESEND_API_KEY  finish  finishing the rotation from 2026-11-09",
    );
    expect(finish.stderr.text).toContain("Resuming: keypin created key re-new-2");
    expect(w.effects, "no third key").toHaveLength(2);
    expect(w.github.value("acme/mailer", "RESEND_API_KEY")).toBe(w.value());

    expect(await ci(w).run("--approve-revoke", "RESEND_API_KEY")).toBe(0);
    expect(w.effects.at(-1)).toBe("resend revoke re-new-1");
  });

  test("a first write to a destination stops before reading anything, and nothing due is success", async () => {
    const w = await world();
    const first = ci(w);
    expect(await first.run("--due", "--yes")).toBe(NEEDS_APPROVAL);
    expect(first.stderr.text).toContain(`first write to ${DESTINATION} (account acme)`);
    expect(first.stderr.text).toContain("Stopped before reading the key");
    expect(w.effects).toEqual([]);
    expect(w.repo.contents.has(ROTATION)).toBe(false);

    w.dates.set(ITEM, "2026-11-01");
    const quiet = ci(w);
    expect(await quiet.run("--due")).toBe(0);
    expect(quiet.stderr.text).toContain("Nothing is due.");
    expect(w.effects).toEqual([]);
  });

  test("the docs' bootstrap: publish on a laptop, answer n to the due key, and a fresh runner rotates it", async () => {
    const w = await world();
    const laptop = machine(w, { terminal: true, answers: ["y", "n"] });
    laptop.disk.contents.set(MAP_FILE, MAP);
    expect(await cli(["publish", "RESEND_API_KEY"], laptop.deps), laptop.stderr.text).toBe(0);
    expect(await laptop.run("--due")).toBe(NEEDS_APPROVAL);
    expect(laptop.stderr.text).toContain("Not confirmed. Nothing was created.");
    expect(w.effects, "answering n rotates nothing").toEqual([]);
    expect(json(w, ROTATION)).toMatchObject({
      issued: [],
      published: [{ key: "RESEND_API_KEY", destination: DESTINATION }],
    });

    expect(await ci(w).run("--due", "--yes")).toBe(0);
    expect(w.effects).toEqual(["resend create re-new-1"]);
    expect(w.github.value("acme/mailer", "RESEND_API_KEY")).toBe(w.value());
  });

  test("--approve-revoke for a key with nothing waiting revokes nothing", async () => {
    const w = await world();
    const run = ci(w);
    expect(await run.run("--approve-revoke", "RESEND_API_KEY")).toBe(1);
    expect(run.stderr.text).toContain(
      "Stopped: RESEND_API_KEY (prod) has no old key waiting for approval. Nothing was revoked.",
    );
    expect(await run.run("--approve-revoke", "STRIPE_KEY")).toBe(1);
    expect(run.stderr.text).toContain("has no issuer");
    expect(await run.run("--due", "RESEND_API_KEY")).toBe(2);
    expect(await run.run("--due", "--approve-revoke")).toBe(2);
    expect(w.effects).toEqual([]);
  });

  test("--approve-revoke without a terminal won't revoke while a destination taken out of the map may use the old key", async () => {
    const w = await rotatedOnceOnALaptop(TWO_REPOS);
    w.repo.contents.set(MAP_FILE, MAP);
    const rotated = ci(w);
    expect(await rotated.run("--due", "--yes")).toBe(0);
    expect(rotated.stderr.text).toContain(`- ${WEB}: not in secretspec.toml any more (last got`);
    expect(json(w, ROTATION)).toMatchObject({
      published: [{ destination: DESTINATION }, { destination: WEB }],
    });

    const refused = ci(w);
    expect(await refused.run("--approve-revoke")).toBe(1);
    expect(refused.stderr.text).toContain(
      `Stopped: something no longer in secretspec.toml may still use the old key re-new-1, so keypin won't revoke it without a terminal. Nothing was revoked. Once nothing uses it, run this in a terminal:\n  ${RERUN} rotate RESEND_API_KEY --approve-revoke`,
    );
    expect(w.effects).toEqual(["resend create re-new-1", "resend create re-new-2"]);

    const declined = machine(w, { terminal: true, answers: ["n"] });
    expect(await declined.run("--approve-revoke")).toBe(0);
    expect(declined.stderr.text).toContain(
      "The old key re-new-1 still works. Revoke it once nothing uses it.",
    );
    expect(w.effects, "a terminal asks first").toHaveLength(2);

    const person = machine(w, { terminal: true, answers: ["y"] });
    expect(await person.run("--approve-revoke")).toBe(0);
    expect(w.effects.at(-1)).toBe("resend revoke re-new-1");
    expect(json(w, ROTATION), "dropped once its key is revoked").toMatchObject({
      published: [{ destination: DESTINATION }],
    });
    expect(JSON.stringify(json(w, ROTATION))).not.toContain(WEB);
  });

  test("a destination only the laptop's receipts know was taken out of the map still stops a fresh runner's revoke", async () => {
    const w = await world(TWO_REPOS);
    const laptop = machine(w, { terminal: true, answers: ["y", "y", "n"] });
    expect(await laptop.run("--due")).toBe(0);
    w.dates.set(ITEM, "2026-08-01");
    w.repo.contents.set(MAP_FILE, MAP);
    w.repo.contents.delete(ROTATION);
    laptop.disk.contents.delete(ROTATION);

    expect(await laptop.run("--due")).toBe(0);
    expect(w.effects).toEqual(["resend create re-new-1", "resend create re-new-2"]);
    expect(json(w, ROTATION)).toMatchObject({
      published: [{ destination: DESTINATION }, { destination: WEB }],
    });

    const refused = ci(w);
    expect(await refused.run("--approve-revoke")).toBe(1);
    expect(refused.stderr.text).toContain(
      "Stopped: something no longer in secretspec.toml may still use",
    );
    expect(w.effects, "nothing revoked").toHaveLength(2);
  });
});

async function recorded(name: string, run: ReturnType<typeof machine>, ...argv: string[]) {
  const exit = await run.run(...argv);
  await expect(
    recording({
      args: ["rotate", ...argv],
      exit,
      stdout: run.stdout.text,
      stderr: run.stderr.text,
      calls: { "runner warnings": run.warnings },
    }),
  ).toMatchFileSnapshot(`./recordings/rotate-due/${name}.txt`);
  return exit;
}

const SESSION = `${MAP}
[profiles.prod.SESSION_SECRET]
description = "SESSION_SECRET"
ref = { item = "session secret", field = "credential" }

[tool.keypin.prod.SESSION_SECRET]
rotate_every = "30d"
issuer = { kind = "random" }
`;

describe("keypin rotate --due says who must act: 0 when nothing does, 3 for an approval, 1 for a fix", () => {
  test("a waiting key that comes due exits 3 every run until someone approves, then rotates", async () => {
    const w = await rotatedOnceOnALaptop();
    expect(await ci(w).run("--due", "--yes")).toBe(0);
    const quiet = ci(w);
    expect(await quiet.run("--due", "--yes"), "waiting, not due yet").toBe(0);
    expect(quiet.stderr.text).toContain("Nothing is due. An old key waits for approval.");

    w.dates.set(ITEM, "2026-08-01");
    const blocked = ci(w);
    expect(await recorded("waiting-key-due", blocked, "--due", "--yes")).toBe(NEEDS_APPROVAL);
    expect(blocked.warnings).toEqual([WARNING]);
    expect(blocked.stderr.text).not.toContain("Nothing is due");
    const check = ci(w);
    expect(await check.run("--check"), "--check reports it as --due does").toBe(NEEDS_APPROVAL);
    expect(check.stderr.text).toContain(
      "FAILED RESEND_API_KEY (prod) was due 2026-10-30, but keypin won't rotate it while its old key waits for approval.",
    );
    expect(check.warnings).toEqual([WARNING]);
    expect(check.stderr.text).not.toContain("is ready for keypin rotate --due");
    expect(check.stderr.text).toContain("Approve what waits above, then run the check again.");
    expect(await ci(w).run("--due", "--yes"), "still blocked the next day").toBe(NEEDS_APPROVAL);
    expect(w.effects).toHaveLength(2);

    expect(await ci(w).run("--approve-revoke")).toBe(0);
    expect(await ci(w).run("--due", "--yes")).toBe(0);
    expect(w.effects).toEqual([
      "resend create re-new-1",
      "resend create re-new-2",
      "resend revoke re-new-1",
      "resend create re-new-3",
    ]);
  });

  test("a key with no rotated date fails the run, and the other keys still rotate", async () => {
    const w = await world(SESSION);
    w.inner.values.set("session secret", "s_old_sentinel_value_1d4e");
    w.dates.delete(ITEM);
    w.dates.set("session secret", "2026-08-01");
    const run = ci(w);
    expect(await recorded("undated-key-fails", run, "--due", "--yes")).toBe(1);
    expect(run.stderr.text).toContain("SESSION_SECRET  rotate  was due 2026-08-31");
    expect(w.inner.values.get("session secret")).not.toBe("s_old_sentinel_value_1d4e");
    expect(w.effects).toEqual([]);
  });

  test("a rotated date the vault couldn't read fails the run", async () => {
    const w = await world();
    w.vault.metadata = async () => {
      throw new Error("the service account was deleted");
    };
    const run = ci(w);
    expect(await run.run("--due", "--yes")).toBe(1);
    expect(run.stderr.text).toContain("keypin: the service account was deleted");
    expect(run.stderr.text).toContain(
      "FAILED RESEND_API_KEY: the vault's rotated date couldn't be read, so keypin can't tell when it's due. Fix the error above, then run this again.",
    );
    expect(w.effects).toEqual([]);
  });

  test("a vault that keeps no rotated date is skipped, as --check already says", async () => {
    const w = await world();
    w.dates.delete(ITEM);
    const run = machine(w, {
      vaults: vaults.map((vault) => ({ ...vault, keepsRotated: false as const })),
    });
    expect(await run.run("--due", "--yes"), run.stderr.text).toBe(0);
    expect(run.stderr.text).toContain("RESEND_API_KEY  skip  no rotated date in the vault");
    expect(run.stderr.text).toContain("Nothing is due.");

    w.gh.revoked = true;
    const refused = machine(w, {
      vaults: vaults.map((vault) => ({ ...vault, keepsRotated: false as const })),
    });
    expect(await refused.run("--due"), "no login is checked for a key --due skips").toBe(0);
    expect(refused.stderr.text).not.toContain("Credentials");
  });
});

describe("keypin rotate --due checks the credentials it runs with, on days nothing is due too", () => {
  const RENEW =
    "Renew it: make a new token with the same access and sign gh in with it: gh auth login --hostname github.com --with-token < token.txt. In a workflow, replace the secret that holds it.";
  const idle = async (expires?: string) => {
    const w = await world();
    w.dates.set(ITEM, "2026-11-01");
    if (expires !== undefined) w.gh.tokenExpires = expires;
    return w;
  };

  test("a GitHub token with weeks left is listed, and the run passes", async () => {
    const run = ci(await idle("2027-01-30 12:00:00 UTC"));
    expect(await run.run("--due")).toBe(0);
    expect(run.stderr.text).toContain(
      "Credentials\n  GitHub acme/mailer: the GitHub token for the active gh login expires 2027-01-30, in 82 days\n",
    );
    expect(run.warnings).toEqual([]);
  });

  test("under 14 days left warns, and the run passes", async () => {
    const run = ci(await idle("2026-11-20 12:00:00 UTC"));
    expect(await run.run("--due")).toBe(0);
    expect(run.warnings).toEqual([
      `A credential expires soon: GitHub acme/mailer: the GitHub token for the active gh login expires 2026-11-20, in 11 days. ${RENEW}`,
    ]);
  });

  test("under 7 days left fails the run, with the steps to renew it", async () => {
    const w = await idle("2026-11-14 12:00:00 UTC");
    const run = ci(w);
    expect(await recorded("github-token-expires", run, "--due")).toBe(1);
    expect(run.stderr.text).toContain("Nothing is due.");
    expect(run.stderr.text).toContain(RENEW);
    expect(await ci(w).run("--check")).toBe(1);
    expect(w.effects).toEqual([]);
  });

  test("an expiry at or before now is unknown: it warns and never fails", async () => {
    for (const expires of ["2026-11-09 12:00:00 UTC", "2026-11-01 09:00:00 UTC"]) {
      const w = await idle(expires);
      const run = ci(w);
      expect(await run.run("--due")).toBe(0);
      expect(run.warnings).toEqual([
        `A credential's expiry is unknown: GitHub acme/mailer: keypin couldn't read when the GitHub token for the active gh login expires. The login works, but the expiry it reported (${new Date(expires.replace(" UTC", "Z").replace(" ", "T")).toISOString()}) isn't in the future.`,
      ]);
      const check = ci(w);
      await check.run("--check");
      expect(check.warnings).toEqual(run.warnings);
      expect(check.stderr.text).not.toContain("FAILED GitHub");
    }
  });

  test("a token GitHub refuses fails the run", async () => {
    const w = await idle();
    w.gh.revoked = true;
    const run = ci(w);
    expect(await run.run("--due")).toBe(1);
    expect(run.stderr.text).toContain(
      "FAILED GitHub acme/mailer: GitHub refused the token for the active gh login (HTTP 401)",
    );
  });

  test("a token without an expiry adds nothing", async () => {
    const run = ci(await idle());
    expect(await run.run("--due")).toBe(0);
    expect(run.stderr.text).not.toContain("Credentials");
  });
});

describe("keypin rotate --due after a person replaced a waiting key by hand", () => {
  const HAND = "re_hand_sentinel_value_9a3d";

  async function replacedByHand(rotated: string) {
    const w = await rotatedOnceOnALaptop();
    expect(await ci(w).run("--due", "--yes")).toBe(0);
    expect(json(w, ROTATION)).toMatchObject({
      issued: [{ id: "re-new-2", old: { id: "re-new-1", revoked: false } }],
    });
    w.known[HAND] = "hand-1";
    w.keys.save({ ...w.keys.load(), live: ["key-0", "hand-1"] });
    w.inner.values.set(ITEM, HAND);
    w.dates.set(ITEM, rotated);
    return w;
  }

  test("a due key rotates from the vault's value, and nothing the old record names is revoked", async () => {
    const w = await replacedByHand("2026-08-01");
    const run = ci(w);
    expect(await run.run("--due", "--yes")).toBe(0);
    expect(run.stderr.text).toContain("RESEND_API_KEY  rotate  was due 2026-10-30");
    expect(run.warnings).toEqual([]);
    expect(w.effects).toEqual([
      "resend create re-new-1",
      "resend create re-new-2",
      "resend create re-new-3",
    ]);
    expect(w.github.value("acme/mailer", "RESEND_API_KEY")).toBe(w.value());
    expect(json(w, ROTATION)).toMatchObject({ issued: [{ id: "re-new-3" }] });

    const later = ci(w);
    expect(await later.run("--due", "--yes")).toBe(0);
    expect(later.stderr.text).toContain("RESEND_API_KEY  skip  not due until 2027-02-07");
    expect(await later.run("--approve-revoke")).toBe(0);
    expect(w.effects, "the hand-made key is never revoked").toHaveLength(3);
    expect(w.keys.load().live).toContain("hand-1");
  });

  test("a key that isn't due is skipped for its date, not shown as waiting", async () => {
    const w = await replacedByHand("2026-11-09");
    const run = ci(w);
    expect(await run.run("--due", "--yes")).toBe(0);
    expect(run.stderr.text).toContain("RESEND_API_KEY  skip  not due until 2027-02-07");
    expect(run.stderr.text).toContain("Nothing is due.\n");
    expect(run.stderr.text).not.toContain("waits");
    expect(run.warnings).toEqual([]);
    expect(w.effects).toHaveLength(2);
  });

  test("--approve-revoke revokes nothing", async () => {
    const w = await replacedByHand("2026-11-09");
    const one = ci(w);
    expect(await one.run("--approve-revoke", "RESEND_API_KEY")).toBe(1);
    expect(one.stderr.text).toContain(
      "Stopped: RESEND_API_KEY (prod) has no old key waiting for approval. Nothing was revoked.",
    );
    const all = ci(w);
    expect(await all.run("--approve-revoke")).toBe(0);
    expect(all.stderr.text).toContain("No old key waits for approval in prod.");
    expect(w.effects).toHaveLength(2);
    expect(w.keys.load().live).toEqual(["key-0", "hand-1"]);
  });

  test("a vault that can't be read keeps the old key waiting, and a due key that waits needs approval", async () => {
    const w = await replacedByHand("2026-08-01");
    w.inner.values.delete(ITEM);
    const run = ci(w);
    expect(await run.run("--due", "--yes")).toBe(NEEDS_APPROVAL);
    expect(run.stderr.text).toContain('no item "mailer resend key"');
    expect(run.stderr.text).toContain(
      "RESEND_API_KEY  wait  rotated 2026-11-09, the old key waits; was due 2026-10-30",
    );
    expect(run.stderr.text).toContain(
      "FAILED RESEND_API_KEY (prod) was due 2026-10-30, but keypin won't rotate it while its old key waits for approval.",
    );
    expect(w.effects).toHaveLength(2);
  });

  test("--check fails when it can't read a waiting key's vault item, instead of calling the key ready", async () => {
    const w = await rotatedOnceOnALaptop();
    expect(await ci(w).run("--due", "--yes")).toBe(0);
    w.dates.set(ITEM, "2026-08-01");
    const read = w.vault.read.bind(w.vault);
    let failed = false;
    Object.assign(w.vault, {
      read: async (ref: KeyRef) => {
        if (failed) return read(ref);
        failed = true;
        throw new Error("1Password: the request timed out");
      },
    });
    const check = ci(w);
    expect(await check.run("--check")).toBe(1);
    expect(check.stderr.text).toContain(
      "keypin couldn't read its vault item, so it can't tell whether its old key still waits for approval",
    );
    expect(check.stderr.text).not.toContain("is ready for keypin rotate --due");
  });

  test("an item replaced under the same reference keeps the old key waiting, its value isn't read, and --check names the first write it needs", async () => {
    const w = await replacedByHand("2026-08-01");
    w.inner.itemIds.set(ITEM, "id-replaced");
    w.inner.log.length = 0;
    const run = ci(w);
    expect(await run.run("--due", "--yes")).toBe(NEEDS_APPROVAL);
    expect(run.stderr.text).toContain(
      "RESEND_API_KEY  wait  rotated 2026-11-09, the old key waits; was due 2026-10-30",
    );
    const check = ci(w);
    expect(await check.run("--check")).toBe(1);
    expect(check.stderr.text).toContain("first write to github-actions:acme/mailer:RESEND_API_KEY");
    expect(check.stderr.text).not.toContain("while its old key waits for approval");
    expect(w.inner.log.filter((line) => line.startsWith("read"))).toEqual([]);
    expect(w.effects).toHaveLength(2);
  });

  test("a key published by hand after the rotation is skipped for its date, not finished", async () => {
    const w = await replacedByHand("2026-11-09");
    const laptop = machine(w, { terminal: true, answers: ["y"] });
    laptop.disk.contents.set(MAP_FILE, MAP);
    expect(await cli(["publish", "RESEND_API_KEY"], laptop.deps), laptop.stderr.text).toBe(0);
    expect(await laptop.run("--due")).toBe(0);
    expect(w.github.value("acme/mailer", "RESEND_API_KEY")).toBe(HAND);

    const run = ci(w);
    expect(await run.run("--due", "--yes")).toBe(0);
    expect(run.stderr.text).toContain("RESEND_API_KEY  skip  not due until 2027-02-07");
    expect(w.effects).toHaveLength(2);
  });
});

describe("keypin rotate --check in a terminal", () => {
  test("a rotation left unfinished by a newly listed destination needs approval, and no value is read", async () => {
    const w = await rotatedOnceOnALaptop();
    w.repo.contents.set(MAP_FILE, TWO_REPOS);
    w.inner.log.length = 0;
    const laptop = machine(w, { terminal: true });
    expect(await laptop.run("--check")).toBe(1);
    expect(laptop.stderr.text).toContain(`Needs approval:\n  first write to ${WEB}`);
    expect(w.inner.log.filter((line) => line.startsWith("read"))).toEqual([]);
    expect(w.effects).toHaveLength(1);
  });
});

describe("keypin rotate --check, the setup check a workflow runs before the first rotation", () => {
  const published = async () => {
    const w = await world();
    const laptop = machine(w, { terminal: true, answers: ["y", "n"] });
    laptop.disk.contents.set(MAP_FILE, MAP);
    expect(await cli(["publish", "RESEND_API_KEY"], laptop.deps)).toBe(0);
    expect(await laptop.run("--due")).toBe(NEEDS_APPROVAL);
    w.inner.log.length = 0;
    return w;
  };
  const unchanged = (w: World) => {
    expect(w.effects).toEqual([]);
    expect(w.inner.log.filter((line) => !/^(read|ids) /.test(line))).toEqual([]);
  };

  test("passes once .keypin/ holds the receipts, for a key that isn't due yet too, and changes nothing", async () => {
    const w = await published();
    w.dates.set(ITEM, "2026-11-01");
    const rotation = w.repo.contents.get(ROTATION);
    const status = w.repo.contents.get(STATUS);
    const github = w.github.value("acme/mailer", "RESEND_API_KEY");
    const run = ci(w);
    expect(await run.run("--check"), run.stderr.text).toBe(0);
    expect(run.stderr.text).toContain("RESEND_API_KEY  check  not due until 2027-01-30");
    expect(run.stderr.text).toContain("STRIPE_KEY      skip   no issuer");
    expect(run.stderr.text).toContain("Resend  the admin key lists 1 API key");
    expect(run.stderr.text).toContain("RESEND_API_KEY (prod) is ready for keypin rotate --due.");
    expect(run.stderr.text).toContain(
      "Every key --due rotates passed the checks. Nothing was created or written, so no destination was asked to take a write.",
    );
    unchanged(w);
    expect(w.inner.log, "only the key and its admin key").toEqual([
      "ids mailer resend key",
      "read mailer resend key",
      "read resend admin key",
    ]);
    expect(w.repo.contents.get(ROTATION)).toBe(rotation);
    expect(w.github.value("acme/mailer", "RESEND_API_KEY")).toBe(github);
    expect(w.repo.contents.get(STATUS)).toBe(status);
    for (const value of [OLD, ADMIN]) expect(run.stderr.text).not.toContain(value);
  });

  test("fails before reading the key or the admin key when a first write would wait for approval", async () => {
    const w = await world();
    const run = ci(w);
    expect(await run.run("--check")).toBe(1);
    expect(run.stderr.text).toContain(`Needs approval:\n  first write to ${DESTINATION}`);
    expect(run.stderr.text).toContain(
      "A scheduled run would stop here. Publish RESEND_API_KEY from your laptop (keypin publish RESEND_API_KEY), run keypin rotate --due there, and commit .keypin/.",
    );
    expect(run.stderr.text).toContain("Fix what failed above, then run the check again.");
    expect(w.inner.log).toEqual(["ids mailer resend key"]);
    unchanged(w);
  });

  test("fails when the admin key, the GitHub token or the rotated date isn't right", async () => {
    const w = await published();
    w.inner.values.set("resend admin key", "re_other_admin");
    const admin = ci(w);
    expect(await admin.run("--check")).toBe(1);
    expect(admin.stderr.text).toContain("Stopped: an account check failed.");

    w.inner.values.set("resend admin key", ADMIN);
    const repo = w.gh.repos["acme/mailer"];
    assert(repo);
    repo.push = false;
    const token = ci(w);
    expect(await token.run("--check")).toBe(1);
    expect(token.stderr.text).toContain("has no write access to acme/mailer");

    repo.push = true;
    w.dates.delete(ITEM);
    const undated = ci(w);
    expect(await undated.run("--check")).toBe(1);
    expect(undated.stderr.text).toContain(
      "FAILED RESEND_API_KEY: no rotated date in the vault, so keypin rotate --due never rotates it.",
    );
    unchanged(w);
  });

  test("a dated schedule on a vault that keeps no rotated date fails, and says the two ways out", async () => {
    const w = await published();
    w.dates.delete(ITEM);
    const undated = machine(w, {
      vaults: vaults.map((vault) => ({ ...vault, keepsRotated: false as const })),
    });
    expect(await undated.run("--check"), undated.stderr.text).toBe(1);
    expect(undated.stderr.text).toContain(
      'FAILED RESEND_API_KEY (prod): its vault keeps no rotation date, so scheduled rotation can\'t cover it. rotate_every applies to RESEND_API_KEY in every profile, so either set it to "never" (or remove it) in every [tool.keypin.<profile>.RESEND_API_KEY] that sets it, which stops scheduled rotation of RESEND_API_KEY in every profile, or keep its prod value in a vault that keeps rotation dates. Rotate it by hand with keypin rotate RESEND_API_KEY --profile prod.',
    );
    unchanged(w);
  });

  test("a dated schedule on a vault that keeps no rotated date fails while an old key waits too", async () => {
    const w = await rotatedOnceOnALaptop();
    expect(await ci(w).run("--due", "--yes")).toBe(0);
    const undated = machine(w, {
      vaults: vaults.map((vault) => ({ ...vault, keepsRotated: false as const })),
    });
    expect(await undated.run("--check"), undated.stderr.text).toBe(1);
    expect(undated.stderr.text).toContain(
      "RESEND_API_KEY  check  rotated 2026-11-09, the old key waits",
    );
    expect(undated.stderr.text).toContain(
      "FAILED RESEND_API_KEY (prod): its vault keeps no rotation date, so scheduled rotation can't cover it.",
    );
    expect(undated.stderr.text).not.toContain("is ready for keypin rotate --due");
  });

  test("a vault lookup that failed still fails, even where the vault keeps no rotated date", async () => {
    const w = await published();
    w.vault.metadata = async () => {
      throw new Error("the token can't read this config");
    };
    const failed = machine(w, {
      vaults: vaults.map((vault) => ({ ...vault, keepsRotated: false as const })),
    });
    expect(await failed.run("--check")).toBe(1);
    expect(failed.stderr.text).toContain(
      "RESEND_API_KEY: the vault's rotated date couldn't be read",
    );
    expect(failed.stderr.text).not.toContain("Rotate it by hand");
    unchanged(w);
  });

  test("the way out names the profile it checked", async () => {
    const w = await world(
      MAP.replace("[profiles.prod]\nRESEND_API_KEY", "[profiles.dev]\nRESEND_API_KEY")
        .replace("\nSTRIPE_KEY = ", "\n[profiles.prod]\nSTRIPE_KEY = ")
        .replace("[tool.keypin.prod.RESEND_API_KEY]", "[tool.keypin.dev.RESEND_API_KEY]"),
    );
    w.dates.delete(ITEM);
    const undated = machine(w, {
      vaults: vaults.map((vault) => ({ ...vault, keepsRotated: false as const })),
    });
    await undated.run("--check", "--profile", "dev");
    expect(undated.stderr.text).toContain(
      "or keep its dev value in a vault that keeps rotation dates. Rotate it by hand with keypin rotate RESEND_API_KEY --profile dev.",
    );
  });

  test("the next step keeps the environment it checked", async () => {
    const run = ci(
      await world(
        MAP.replace("[profiles.prod]\nRESEND_API_KEY", "[profiles.dev]\nRESEND_API_KEY")
          .replace("\nSTRIPE_KEY = ", "\n[profiles.prod]\nSTRIPE_KEY = ")
          .replace("[tool.keypin.prod.RESEND_API_KEY]", "[tool.keypin.dev.RESEND_API_KEY]"),
      ),
    );
    expect(await run.run("--check", "--profile", "dev"), run.stderr.text).toBe(1);
    expect(run.stderr.text).toContain(
      "Publish RESEND_API_KEY from your laptop (keypin publish RESEND_API_KEY --profile dev), run keypin rotate --due --profile dev there",
    );
  });

  test("notes keys in the account's default Shared vault, which a service account can't be granted", async () => {
    const shared = (title: string, value: string) => ({
      ...item(title, [
        field("credential", "Concealed", value),
        field("rotated", "Date", "2026-08-01"),
      ]),
      vaultId: "vault-Shared",
    });
    const onePassword = fakeOnePassword([
      shared(ITEM, OLD),
      shared("resend admin key", ADMIN),
      shared("stripe key", "sk_x"),
    ]);
    const w = await world(MAP.replaceAll("Private", "Shared"));
    w.vault = onePasswordBackend(async () => onePassword.client);
    const run = ci(w);
    expect(await run.run("--check")).toBe(1);
    expect(run.stderr.text).toContain(
      "Note: 1Password vault \"Shared\" (1Password account my.1password.com) is the account's default Shared vault. A service account can't be granted it, so scheduled rotation can't read the keys there; move them to a vault you create (docs/guides/service-accounts.md)\n\nFix what failed above",
    );
    expect(onePassword.calls.lists.vaults).toBe(1);
  });

  test("no Shared vault note for a key --due skips, such as one that never rotates", async () => {
    const at = (vaultId: string, title: string, value: string) => ({
      ...item(title, [
        field("credential", "Concealed", value),
        field("rotated", "Date", "2026-08-01"),
      ]),
      vaultId,
    });
    const onePassword = fakeOnePassword([
      at("vault-1", ITEM, OLD),
      at("vault-1", "resend admin key", ADMIN),
      at("vault-1", "stripe key", "sk_x"),
      at("vault-Shared", "stripe admin key", ADMIN),
    ]);
    const map = MAP.replace(
      'rotate_every = "30d"',
      'rotate_every = "never"\nissuer = { kind = "resend", admin = "op://Shared/stripe admin key/credential", permission = "sending_access" }',
    );
    const w = await world(map);
    w.vault = onePasswordBackend(async () => onePassword.client);
    const run = ci(w);
    await run.run("--check");
    expect(run.stderr.text).toContain("never rotates");
    expect(run.stderr.text).not.toContain("default Shared vault");
  });

  test("takes only --profile", async () => {
    const run = ci(await world());
    for (const extra of [
      ["--due"],
      ["--plan"],
      ["--yes"],
      ["--approve-revoke"],
      ["RESEND_API_KEY"],
    ])
      expect(await run.run("--check", ...extra)).toBe(2);
  });
});
