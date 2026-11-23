import { describe, expect, test } from "vite-plus/test";
import type { Fetch, VaultBackend } from "@keypin/core";
import { memoryKeys, resendFetch } from "@keypin/connectors/resend/testing";
import { cli } from "../src/cli";
import { issuer } from "../src/start";
import { fakeDeps, fakeDestinations, memoryFiles, writableVault } from "./fakes";

const OLD = "re_old_sentinel_value_5d2a";
const ADMIN = "re_admin_sentinel_value_8c3e";
const NEW = (n: number) => `re_new_${n}_7d1b`;
const GITHUB = "github-actions:acme/mailer RESEND_API_KEY";
const WORKER = "cloudflare-worker:mailer RESEND_API_KEY";

const ISSUER = `issuer = { kind = "resend", admin = "op://Private/resend admin key/credential", permission = "sending_access" }`;

const MAP = `
[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
RESEND_API_KEY = { description = "RESEND_API_KEY", ref = { item = "mailer resend key", field = "credential" } }

[tool.keypin.prod.RESEND_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/mailer" }]
${ISSUER}
`;

const WITH_WORKER = MAP.replace(
  "publish = [{",
  'publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "mailer" }, {',
);

const VALUES = { "mailer resend key": OLD, "resend admin key": ADMIN };

interface World {
  disk: ReturnType<typeof memoryFiles>;
  backend: VaultBackend;
  keys: ReturnType<typeof memoryKeys>;
}

function world(backend: VaultBackend, map = MAP): World {
  return {
    disk: memoryFiles({ "/work/billing/secretspec.toml": map }),
    backend,
    keys: memoryKeys(["re-old"]),
  };
}

function rotation(at: World, answers: string[] = []) {
  const requests: string[] = [];
  const resend = resendFetch({
    admin: ADMIN,
    known: { [OLD]: "re-old" },
    tokenPrefix: "re_new_",
    keys: at.keys,
    effect: () => undefined,
  });
  const recorded: Fetch = (url, init) => {
    requests.push(`${init.method} ${new URL(url).pathname}`);
    return resend(url, init);
  };
  const destinations = fakeDestinations();
  const asked: string[] = [];
  const fake = fakeDeps({
    disk: at.disk,
    backend: at.backend,
    deps: {
      env: {
        INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "client-id-1",
        INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "client-secret-4e7b",
      },
      destination: destinations.build,
      issuer: (spec, admin) => issuer(spec, admin, recorded),
      isTerminal: true,
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
    },
  });
  const run = (...args: string[]) => cli(["rotate", "RESEND_API_KEY", ...args], fake.deps);
  const live = () => at.keys.load().live;
  return { ...fake, run, requests, asked, delivered: destinations.delivered, live };
}

describe("keypin rotate recovers without losing a key", () => {
  test("an admin key that can't be read stops before Resend makes a key", async () => {
    const vault = writableVault({ "mailer resend key": OLD });
    const run = rotation(world(vault.vault), ["y"]);
    expect(await run.run()).toBe(1);
    expect(run.stderr.text).toContain(
      'Stopped: couldn\'t read no item "resend admin key". Nothing was created.',
    );
    expect(run.requests, "Resend never heard from keypin").toEqual([]);
    expect(run.live()).toEqual(["re-old"]);
    expect(vault.values.get("mailer resend key")).toBe(OLD);
    expect(run.delivered(OLD)).toEqual([]);
  });

  test("a saved key whose item ID can't be looked up stays live, and the rerun publishes it without another", async () => {
    const vault = writableVault(VALUES);
    const lookup = { fails: false };
    const backend: VaultBackend = {
      ...vault.vault,
      itemIds: async (ref) => {
        if (lookup.fails) throw new Error("1Password: the app is locked");
        return vault.vault.itemIds(ref);
      },
    };
    const at = world(backend);
    lookup.fails = true;
    const first = rotation(at, ["y"]);
    expect(await first.run()).toBe(1);
    expect(first.stderr.text).toContain(
      "    1Password: the app is locked\nStopped. The new key is in 1Password, and the old key still works. To continue, run:",
    );
    expect(vault.values.get("mailer resend key"), "the vault holds the new key").toBe(NEW(1));
    expect(first.live(), "the new key stays live: the vault holds it").toEqual([
      "re-old",
      "re-new-1",
    ]);
    expect(first.delivered(NEW(1))).toEqual([]);

    lookup.fails = false;
    const again = rotation(at, ["y"]);
    expect(await again.run()).toBe(0);
    expect(again.stderr.text).toContain("Resuming: keypin created key re-new-1 at Resend");
    expect(again.delivered(NEW(1))).toEqual([GITHUB]);
    expect(
      again.requests.filter((r) => r.startsWith("POST")),
      "no second key",
    ).toEqual([]);
    expect(again.live()).toEqual(["re-old", "re-new-1"]);
  });

  test("a destination added after the old key was revoked gets the key, and keypin doesn't revoke again", async () => {
    const vault = writableVault(VALUES);
    const at = world(vault.vault);
    expect(await rotation(at, ["y"]).run()).toBe(0);
    const second = rotation(at, ["y", "y"]);
    expect(await second.run()).toBe(0);
    expect(second.requests, "the second rotation revokes re-new-1").toContain(
      "DELETE /api-keys/re-new-1",
    );
    expect(second.live()).toEqual(["re-old", "re-new-2"]);

    at.disk.contents.set("/work/billing/secretspec.toml", WITH_WORKER);
    const added = rotation(at, ["y", "y"]);
    expect(await added.run()).toBe(0);
    expect(added.delivered(NEW(2))).toEqual([WORKER]);
    expect(added.asked, "one question: write the new destination").toHaveLength(1);
    expect(added.asked.join("")).not.toContain("Revoke");
    expect(
      added.requests.filter((r) => !r.startsWith("GET")),
      "no create and no revoke",
    ).toEqual([]);
  });
});
