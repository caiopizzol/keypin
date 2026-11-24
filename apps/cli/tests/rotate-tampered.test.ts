import { describe, expect, test } from "vite-plus/test";
import { isRecord, type KeyRef, type VaultBackend } from "@keypin/core";
import { day } from "@keypin/core/testing";
import { GitHubSecretDestination } from "@keypin/connectors/github";
import { githubFetch } from "@keypin/connectors/github/testing";
import { onePasswordRef } from "@keypin/connectors/onepassword";
import { type FakeOpenAIKey, memoryKeys, openaiFetch } from "@keypin/connectors/openai/testing";
import { cli } from "../src/cli";
import { issuer as connect } from "../src/start";
import { fakeDeps, memoryFiles, parseJson, writableVault } from "./fakes";

const OLD = "sk-svcacct-old-sentinel-7d2a";
const ADMIN = "sk-admin-sentinel-5c1f";
const ITEM = "mailer openai key";
const MAP_FILE = "/work/billing/secretspec.toml";
const ROTATION = "/work/billing/.keypin/rotation.json";
const BOT = { type: "service_account", id: "svc_bot", name: "billing-bot" } as const;
const SIBLING: FakeOpenAIKey = {
  id: "key_jobs",
  name: "jobs",
  value: "sk-svcacct-jobs-sentinel-4e8b",
  owner: BOT,
};
const WEB: FakeOpenAIKey = {
  id: "key_web",
  name: "web",
  value: "sk-svcacct-web-sentinel-1d9e",
  owner: { type: "service_account", id: "svc_web", name: "web-app" },
};

const MAP = `
[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
OPENAI_API_KEY = { description = "OPENAI_API_KEY", ref = { item = "${ITEM}", field = "credential" } }

[tool.keypin.prod.OPENAI_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/mailer" }]
issuer = { kind = "openai", admin = "op://Private/openai admin key/credential", project_id = "proj_1", scopes = [] }
`;

async function waitingForApproval() {
  const effects: string[] = [];
  const keys = memoryKeys([{ id: "key_old", name: "prod", value: OLD, owner: BOT }, SIBLING, WEB]);
  const openai = openaiFetch({
    admin: ADMIN,
    projectId: "proj_1",
    tokenPrefix: "sk-svcacct-new-sentinel-",
    keys,
    effect: (line) => void effects.push(line),
  });
  const github = await githubFetch({
    login: "acme-bot",
    repos: { "acme/mailer": { owner: "acme", push: true } },
  });
  const inner = writableVault({ [ITEM]: OLD, "openai admin key": ADMIN });
  const vault: VaultBackend = {
    ...inner.vault,
    async metadata(ref: KeyRef) {
      return { rotated: onePasswordRef(ref)?.item === ITEM ? day("2026-08-01") : null };
    },
  };
  const repo = memoryFiles({ [MAP_FILE]: MAP });
  const run = async (argv: string[], answers: string[] = []) => {
    const disk = memoryFiles();
    for (const [path, text] of repo.contents) disk.contents.set(path, text);
    const fake = fakeDeps({
      disk,
      backend: vault,
      deps: {
        isTerminal: answers.length > 0,
        ask: async () => answers.shift() ?? "",
        issuer: (spec, admin) => connect(spec, admin, openai),
        destination: (target) =>
          new GitHubSecretDestination({
            repo: String(target.repo),
            token: async () => "fake-gh-token",
            fetch: github.fetch,
          }),
      },
    });
    const code = await cli(["rotate", ...argv], fake.deps);
    const text = disk.contents.get(ROTATION);
    if (text !== undefined) repo.contents.set(ROTATION, text);
    return { code, stderr: fake.stderr.text };
  };
  repo.contents.set(ROTATION, '{ "version": 1, "issued": [], "published": [] }\n');
  const laptop = await run(["--due"], ["y", "n"]);
  expect(laptop.code, laptop.stderr).toBe(0);
  expect(effects).toEqual(["openai create key_new1 for svc_bot"]);
  const rotation = () => parseJson(repo.contents.get(ROTATION) ?? "null");
  expect(rotation()).toMatchObject({
    issued: [{ id: "svc_bot/key_new1", old: { id: "svc_bot/key_old", revoked: false } }],
  });
  const tamper = (fields: { id?: string; old?: string }) => {
    const text = repo.contents.get(ROTATION) ?? "";
    const swapped = text
      .replace('"id": "svc_bot/key_new1"', `"id": "${fields.id ?? "svc_bot/key_new1"}"`)
      .replace('"id": "svc_bot/key_old"', `"id": "${fields.old ?? "svc_bot/key_old"}"`);
    expect(swapped).not.toBe(text);
    repo.contents.set(ROTATION, swapped);
  };
  const unproven = () => {
    const file = parseJson(repo.contents.get(ROTATION) ?? "null");
    if (!isRecord(file) || !Array.isArray(file.issued)) throw new Error("no rotation file");
    for (const issued of file.issued) if (isRecord(issued)) delete issued.proof;
    repo.contents.set(ROTATION, `${JSON.stringify(file, null, 2)}\n`);
  };
  return { run, effects, keys, rotation, tamper, unproven };
}

const NAMES = ".keypin/rotation.json names this key: check who changed it.";

describe("keypin rotate --approve-revoke with a changed .keypin/rotation.json", () => {
  test("revokes the retired key of this rotation", async () => {
    const w = await waitingForApproval();
    expect((await w.run(["--approve-revoke"])).code).toBe(0);
    expect(w.effects).toEqual(["openai create key_new1 for svc_bot", "openai revoke key_old"]);
    expect(w.rotation()).toMatchObject({ issued: [{ old: { revoked: true } }] });
  });

  test("refuses the key the vault holds", async () => {
    const w = await waitingForApproval();
    w.tamper({ old: "svc_bot/key_new1" });
    const refused = await w.run(["--approve-revoke"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `Stopped: keypin won't revoke key key_new1 of service account billing-bot: it's the key the vault holds. Nothing was revoked. ${NAMES}`,
    );
    expect(w.effects).toEqual(["openai create key_new1 for svc_bot"]);
  });

  test("refuses any other key, even a live one of the same service account", async () => {
    for (const [old, label] of [
      ["svc_web/key_new1", "key_new1 of service account web-app"],
      ["svc_bot/key_jobs", "key_jobs of service account billing-bot"],
      ["svc_bot/key_web", "key_web of service account billing-bot"],
    ] as const) {
      const w = await waitingForApproval();
      w.tamper({ old });
      const refused = await w.run(["--approve-revoke"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        `Stopped: keypin won't revoke key ${label}: keypin's record of this rotation doesn't match the vault's value. Nothing was revoked. ${NAMES}`,
      );
      expect(w.effects).toEqual(["openai create key_new1 for svc_bot"]);
      expect(w.rotation()).toMatchObject({ issued: [{ old: { id: old, revoked: false } }] });
    }
  });

  test("a rotation with no proof is never revoked, and is recorded once the key is gone", async () => {
    const w = await waitingForApproval();
    w.unproven();
    const stopped =
      "Stopped: .keypin/rotation.json has no proof that this rotation replaced key key_old of service account billing-bot: an older keypin recorded it, or someone removed the proof. Nothing was revoked. Once nothing uses key key_old of service account billing-bot, delete it at https://platform.openai.com/settings/organization/api-keys, then run this again to record it:";
    for (const answers of [[], ["y"]]) {
      const refused = await w.run(["--approve-revoke"], answers);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(stopped);
    }
    expect(w.effects).toEqual(["openai create key_new1 for svc_bot"]);

    w.keys.save({ ...w.keys.load(), live: w.keys.load().live.filter((k) => k.id !== "key_old") });
    const recorded = await w.run(["--approve-revoke"]);
    expect(recorded.code).toBe(0);
    expect(recorded.stderr).toContain(
      "Key key_old of service account billing-bot is gone from OpenAI, so keypin records it as revoked.",
    );
    expect(w.rotation()).toMatchObject({ issued: [{ old: { revoked: true } }] });
    expect(w.effects).toEqual(["openai create key_new1 for svc_bot"]);
  });

  test("a recorded new key that isn't the vault's fails the account check", async () => {
    const w = await waitingForApproval();
    w.tamper({ id: "svc_web/key_web", old: "svc_web/key_web" });
    const refused = await w.run(["--approve-revoke"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "key key_web, the one keypin recorded for the vault's value, is another key in project proj_1",
    );
    expect(w.effects).toEqual(["openai create key_new1 for svc_bot"]);
  });
});
