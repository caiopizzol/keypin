import { describe, expect, test } from "vite-plus/test";
import type { KeyRef, VaultBackend } from "@keypin/core";
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
  const keys = memoryKeys([{ id: "key_old", name: "prod", value: OLD, owner: BOT }, WEB]);
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
  return { run, effects, keys, rotation, tamper };
}

const NAMES = ".keypin/rotation.json names this key: check who changed it.";

describe("keypin rotate --approve-revoke with a changed .keypin/rotation.json", () => {
  test("revokes the retired key of this rotation", async () => {
    const w = await waitingForApproval();
    expect((await w.run(["--approve-revoke"])).code).toBe(0);
    expect(w.effects).toEqual(["openai create key_new1 for svc_bot", "openai revoke key_old"]);
    expect(w.rotation()).toMatchObject({ issued: [{ old: { revoked: true } }] });
  });

  test("refuses the key the vault holds, under its own ID or another", async () => {
    for (const [old, label] of [
      ["svc_bot/key_new1", "key_new1 of service account billing-bot"],
      ["svc_web/key_new1", "key_new1 of service account web-app"],
    ] as const) {
      const w = await waitingForApproval();
      w.tamper({ old });
      const refused = await w.run(["--approve-revoke"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        `Stopped: keypin won't revoke key ${label}: it's the key the vault holds. Nothing was revoked. ${NAMES}`,
      );
      expect(w.effects).toEqual(["openai create key_new1 for svc_bot"]);
      expect(w.rotation()).toMatchObject({ issued: [{ old: { id: old, revoked: false } }] });
    }
  });

  test("refuses a key of another service account in the project", async () => {
    const w = await waitingForApproval();
    w.tamper({ old: "svc_bot/key_web" });
    const refused = await w.run(["--approve-revoke"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `Stopped: keypin won't revoke key key_web of service account billing-bot: it belongs to service account web-app, not to service account billing-bot, which owns the vault's key. Nothing was revoked. ${NAMES}`,
    );
    expect(w.effects).toEqual(["openai create key_new1 for svc_bot"]);
    expect(w.keys.load().live.map((key) => key.id)).toContain("key_web");
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
