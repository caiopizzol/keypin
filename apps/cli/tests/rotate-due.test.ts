import { assert, describe, expect, test } from "vite-plus/test";
import type { KeyRef, VaultBackend } from "@keypin/core";
import { day } from "@keypin/core/testing";
import { GitHubSecretDestination } from "@keypin/connectors/github";
import { type FakeGitHub, githubFetch } from "@keypin/connectors/github/testing";
import { onePasswordRef } from "@keypin/connectors/onepassword";
import { memoryKeys, resendFetch } from "@keypin/connectors/resend/testing";
import { cli } from "../src/cli";
import { NEEDS_APPROVAL } from "../src/approval";
import { issuer as connect } from "../src/start";
import { fakeDeps, memoryFiles, parseJson, writableVault } from "./fakes";

const OLD = "re_old_sentinel_value_4b1c";
const ADMIN = "re_admin_sentinel_value_7e2f";
const ITEM = "mailer resend key";
const MAP_FILE = "/work/billing/keypin.toml";
const ROTATION = "/work/billing/.keypin/rotation.json";
const STATUS = "/work/billing/.keypin/status.json";
const DESTINATION = "github-actions:acme/mailer:RESEND_API_KEY";
const WEB = "github-actions:acme/web:RESEND_API_KEY";
const RERUN =
  "cd /work/billing && /opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts";

const MAP = `
[1password]
account = "my.1password.com"

[keys.RESEND_API_KEY]
rotate_every = "90d"

[keys.RESEND_API_KEY.prod]
from = "op://Private/${ITEM}/credential"
publish = [{ to = "github-actions", repo = "acme/mailer" }]
issuer = { kind = "resend", admin = "op://Private/resend admin key/credential", permission = "sending_access" }

[keys.STRIPE_KEY]
rotate_every = "30d"
prod = { from = "op://Private/stripe key/credential", publish = [{ to = "github-actions", repo = "acme/mailer" }] }
`;

const TWO_REPOS = MAP.replace(
  'publish = [{ to = "github-actions", repo = "acme/mailer" }]\nissuer',
  'publish = [{ to = "github-actions", repo = "acme/mailer" }, { to = "github-actions", repo = "acme/web" }]\nissuer',
);

async function world(map = MAP) {
  const keys = memoryKeys(["key-0"]);
  const effects: string[] = [];
  const resend = resendFetch({
    admin: ADMIN,
    known: { [OLD]: "key-0" },
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
  return { keys, effects, resend, gh, github, vault, dates, value, repo, inner };
}

type World = Awaited<ReturnType<typeof world>>;

function machine(
  w: World,
  options: { terminal?: boolean; answers?: string[]; runner?: boolean } = {},
) {
  const disk = memoryFiles();
  const answers = [...(options.answers ?? [])];
  const fake = fakeDeps({
    disk,
    backend: w.vault,
    deps: {
      isTerminal: options.terminal ?? false,
      ...(options.runner === false ? { warnRunner: () => false } : {}),
      ask: async () => answers.shift() ?? "",
      issuer: (spec, admin) => connect(spec, admin, w.resend),
      destination: (target) =>
        new GitHubSecretDestination({
          repo: String(target.repo),
          token: async () => "fake-gh-token",
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
  "An old key waits for approval: The old RESEND_API_KEY (prod) still works. Once nothing uses it, run this workflow with approve revoke, or run this in your checkout: keypin rotate RESEND_API_KEY --approve-revoke";
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
    expect(rotated.stderr.text).toContain(`- ${WEB}: not in the map any more (last got`);
    expect(json(w, ROTATION)).toMatchObject({
      published: [{ destination: DESTINATION }, { destination: WEB }],
    });

    const refused = ci(w);
    expect(await refused.run("--approve-revoke")).toBe(1);
    expect(refused.stderr.text).toContain(
      `Stopped: something no longer in the map may still use the old key re-new-1, so keypin won't revoke it without a terminal. Nothing was revoked. Once nothing uses it, run this in a terminal:\n  ${RERUN} rotate RESEND_API_KEY --approve-revoke`,
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
    expect(refused.stderr.text).toContain("Stopped: something no longer in the map may still use");
    expect(w.effects, "nothing revoked").toHaveLength(2);
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

  test("the next step keeps the environment it checked", async () => {
    const run = ci(
      await world(MAP.replace("[keys.RESEND_API_KEY.prod]", "[keys.RESEND_API_KEY.dev]")),
    );
    expect(await run.run("--check", "--env", "dev"), run.stderr.text).toBe(1);
    expect(run.stderr.text).toContain(
      "Publish RESEND_API_KEY from your laptop (keypin publish RESEND_API_KEY --env dev), run keypin rotate --due --env dev there",
    );
  });

  test("takes only --env", async () => {
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
