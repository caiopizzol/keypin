import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, isRecord, type KeyRef, type VaultBackend } from "@keypin/core";
import { day } from "@keypin/core/testing";
import { GitHubSecretDestination } from "@keypin/connectors/github";
import { githubFetch } from "@keypin/connectors/github/testing";
import { onePasswordRef } from "@keypin/connectors/onepassword";
import { type FakeOpenAIKey, memoryKeys, openaiFetch } from "@keypin/connectors/openai/testing";
import { elevenlabsFetch, memoryWorld } from "@keypin/connectors/elevenlabs/testing";
import { cli } from "../src/cli";
import { issuer as connect } from "../src/start";
import { fakeDeps, memoryFiles, parseJson, writableVault } from "./fakes";

const OLD = "sk-svcacct-old-sentinel-7d2a";
const ADMIN = "sk-admin-sentinel-5c1f";
const ITEM = "mailer api key";
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

const map = (issuer: string) => `
[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
API_KEY = { description = "API_KEY", ref = { item = "${ITEM}", field = "credential" } }

[tool.keypin.prod.API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/mailer" }]
issuer = ${issuer}
`;

async function rotatedOnce(provider: { issuer: string; fetch: Fetch; old: string; admin: string }) {
  const github = await githubFetch({
    login: "acme-bot",
    repos: { "acme/mailer": { owner: "acme", push: true } },
  });
  const inner = writableVault({ [ITEM]: provider.old, "issuer admin key": provider.admin });
  const vault: VaultBackend = {
    ...inner.vault,
    async metadata(ref: KeyRef) {
      return { rotated: onePasswordRef(ref)?.item === ITEM ? day("2026-08-01") : null };
    },
  };
  const repo = memoryFiles({ [MAP_FILE]: map(provider.issuer) });
  const run = async (argv: string[], answers: string[] = []) => {
    const disk = memoryFiles();
    for (const [path, text] of repo.contents) disk.contents.set(path, text);
    const fake = fakeDeps({
      disk,
      backend: vault,
      deps: {
        isTerminal: answers.length > 0,
        ask: async () => answers.shift() ?? "",
        issuer: (spec, admin) => connect(spec, admin, provider.fetch),
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
  const rotation = () => parseJson(repo.contents.get(ROTATION) ?? "null");
  const unproven = () => {
    const file = rotation();
    if (!isRecord(file) || !Array.isArray(file.issued)) throw new Error("no rotation file");
    for (const issued of file.issued) if (isRecord(issued)) delete issued.proof;
    repo.contents.set(ROTATION, `${JSON.stringify(file, null, 2)}\n`);
  };
  return { run, rotation, repo, unproven };
}

async function waitingForApproval() {
  const effects: string[] = [];
  const keys = memoryKeys([{ id: "key_old", name: "prod", value: OLD, owner: BOT }, SIBLING, WEB]);
  const fetch = openaiFetch({
    admin: ADMIN,
    projectId: "proj_1",
    tokenPrefix: "sk-svcacct-new-sentinel-",
    keys,
    effect: (line) => void effects.push(line),
  });
  const issuer = `{ kind = "openai", admin = "op://Private/issuer admin key/credential", project_id = "proj_1", scopes = [] }`;
  const w = await rotatedOnce({ issuer, fetch, old: OLD, admin: ADMIN });
  expect(effects).toEqual(["openai create key_new1 for svc_bot"]);
  expect(w.rotation()).toMatchObject({
    issued: [{ id: "svc_bot/key_new1", old: { id: "svc_bot/key_old", revoked: false } }],
  });
  const tamper = (fields: { id?: string; old?: string }) => {
    const text = w.repo.contents.get(ROTATION) ?? "";
    const swapped = text
      .replace('"id": "svc_bot/key_new1"', `"id": "${fields.id ?? "svc_bot/key_new1"}"`)
      .replace('"id": "svc_bot/key_old"', `"id": "${fields.old ?? "svc_bot/key_old"}"`);
    expect(swapped).not.toBe(text);
    w.repo.contents.set(ROTATION, swapped);
  };
  return { ...w, effects, keys, tamper };
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

  test("a rotation with no proof is never revoked: a person records a manual delete", async () => {
    const w = await waitingForApproval();
    w.unproven();
    const named =
      ".keypin/rotation.json names key svc_bot/key_old as the old key without a proof, so keypin can't confirm it and won't revoke it: an older keypin recorded it, or someone removed the proof. Check which key this rotation replaced at https://platform.openai.com/settings/organization/api-keys, and delete it yourself once nothing uses it.";
    const unattended = await w.run(["--approve-revoke"]);
    expect(unattended.code).toBe(1);
    expect(unattended.stderr).toContain(
      `${named}\nStopped. Nothing was revoked. Once you've deleted it, run this in a terminal to record it:`,
    );
    const declined = await w.run(["--approve-revoke"], ["n"]);
    expect(declined.code).toBe(1);
    expect(declined.stderr).toContain("Nothing was recorded.");
    expect(w.rotation()).toMatchObject({ issued: [{ old: { revoked: false } }] });

    const confirmed = await w.run(["--approve-revoke"], ["y"]);
    expect(confirmed.code).toBe(0);
    expect(confirmed.stderr).toContain("Recorded the old key as revoked. keypin deleted nothing.");
    expect(w.rotation()).toMatchObject({ issued: [{ old: { revoked: true } }] });
    expect(w.effects).toEqual(["openai create key_new1 for svc_bot"]);
    expect(w.keys.load().live.map((key) => key.id)).toContain("key_old");
  });

  test("the manual path keeps the same-key refusal and the warning for removed destinations", async () => {
    const same = await waitingForApproval();
    same.tamper({ old: "svc_bot/key_new1" });
    same.unproven();
    const refused = await same.run(["--approve-revoke"], ["y"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `Stopped: keypin won't revoke key svc_bot/key_new1: it's the key the vault holds. Nothing was revoked. ${NAMES}`,
    );
    expect(same.rotation()).toMatchObject({ issued: [{ old: { revoked: false } }] });

    const moved = await waitingForApproval();
    moved.unproven();
    const file = moved.rotation();
    assert(isRecord(file) && Array.isArray(file.issued) && Array.isArray(file.published));
    const issued: unknown = file.issued[0];
    assert(isRecord(issued) && isRecord(issued.old));
    file.published.push({
      key: "API_KEY",
      environment: "prod",
      destination: "github-actions:acme/web:API_KEY",
      account: "acme",
      generation: issued.old.generation,
      at: "2026-08-01T12:00:00.000Z",
      approved: "0".repeat(16),
    });
    moved.repo.contents.set(ROTATION, `${JSON.stringify(file, null, 2)}\n`);
    const warned = await moved.run(["--approve-revoke"]);
    expect(warned.code).toBe(1);
    expect(warned.stderr).toContain(
      "Not in secretspec.toml any more, so keypin didn't write them; they may still use the old key:\n  - github-actions:acme/web:API_KEY",
    );
  });

  test("--discard on a rotation with no proof replaces the key instead of asking about a delete", async () => {
    const w = await waitingForApproval();
    w.unproven();
    const discarded = await w.run(["API_KEY", "--discard"], ["y", "n"]);
    expect(discarded.stderr).not.toContain("Did you delete the old key yourself?");
    expect(discarded.stderr).toContain("Discarding key");
    expect(w.effects).toEqual([
      "openai create key_new1 for svc_bot",
      "openai create key_new2 for svc_bot",
    ]);
  });

  test("ElevenLabs, which can't tell two live keys apart, still gets the manual path", async () => {
    const effects: string[] = [];
    const world = memoryWorld([
      { account: "sa_app", keyId: "key_old", name: "prod", value: "el-old-sentinel-2b7d" },
    ]);
    const fetch = elevenlabsFetch({
      admin: "el-admin-sentinel-8f1c",
      valuePrefix: "el-new-sentinel-",
      accounts: [{ id: "sa_app", name: "app" }],
      world,
      effect: (line) => void effects.push(line),
    });
    const issuer = `{ kind = "elevenlabs", admin = "op://Private/issuer admin key/credential" }`;
    const w = await rotatedOnce({
      issuer,
      fetch,
      old: "el-old-sentinel-2b7d",
      admin: "el-admin-sentinel-8f1c",
    });
    expect(w.rotation()).toMatchObject({
      issued: [{ old: { id: "sa_app/key_old", revoked: false } }],
    });
    w.unproven();
    const unattended = await w.run(["--approve-revoke"]);
    expect(unattended.code).toBe(1);
    expect(unattended.stderr).toContain("as the old key without a proof");
    expect(unattended.stderr).not.toContain("an account check failed");
    const confirmed = await w.run(["--approve-revoke"], ["y"]);
    expect(confirmed.code).toBe(0);
    expect(confirmed.stderr).toContain("Recorded the old key as revoked. keypin deleted nothing.");
    expect(effects.filter((line) => line.includes("revoke") || line.includes("delete"))).toEqual(
      [],
    );
  });

  test("a recorded new key that isn't the vault's steers nothing and revokes nothing", async () => {
    const w = await waitingForApproval();
    w.tamper({ id: "svc_web/key_web" });
    const refused = await w.run(["--approve-revoke"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `Stopped: keypin won't revoke key key_old of service account billing-bot: keypin's record of this rotation doesn't match the vault's value. Nothing was revoked. ${NAMES}`,
    );
    expect(w.effects).toEqual(["openai create key_new1 for svc_bot"]);
  });
});
