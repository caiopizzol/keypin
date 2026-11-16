import { describe, expect, test } from "vite-plus/test";
import type { Fetch, VaultBackend } from "@keypin/core";
import { infisicalBackend } from "@keypin/connectors/infisical";
import {
  type FakeInfisical,
  infisicalFetch,
  memoryStore,
  mergeHeld,
} from "@keypin/connectors/infisical/testing";
import { memoryKeys, resendFetch } from "@keypin/connectors/resend/testing";
import { cli } from "../src/cli";
import { NEEDS_APPROVAL } from "../src/approval";
import { issuer } from "../src/start";
import { fakeDeps, fakeDestinations, memoryFiles, STATE, writableVault } from "./fakes";

const OLD = "re_old_sentinel_value_5d2a";
const ADMIN = "re_admin_sentinel_value_8c3e";
const NEW = (n: number) => `re_new_${n}_7d1b`;
const GITHUB = "github-actions:acme/mailer RESEND_API_KEY";
const WORKER = "cloudflare-worker:mailer RESEND_API_KEY";

const ISSUER = `issuer = { kind = "resend", admin = "op://Private/resend admin key/credential", permission = "sending_access" }`;

const MAP = `
[1password]
account = "my.1password.com"

[keys.RESEND_API_KEY]
rotate_every = "90d"

[keys.RESEND_API_KEY.prod]
from = "op://Private/mailer resend key/credential"
publish = [
  { to = "github-actions", repo = "acme/mailer" },
]
${ISSUER}
`;

const WITH_WORKER = MAP.replace(
  "publish = [\n",
  'publish = [\n  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "mailer" },\n',
);

const INFISICAL_MAP = `
[infisical]
organization = "acme"

[keys.RESEND_API_KEY]
rotate_every = "90d"

[keys.RESEND_API_KEY.prod]
from = "infisical://mailer/prod/RESEND_API_KEY"
publish = [
  { to = "github-actions", repo = "acme/mailer" },
]
issuer = { kind = "resend", admin = "infisical://mailer/prod/RESEND_ADMIN_KEY", permission = "sending_access" }
`;

const VALUES = { "mailer resend key": OLD, "resend admin key": ADMIN };

interface World {
  disk: ReturnType<typeof memoryFiles>;
  backend: VaultBackend;
  keys: ReturnType<typeof memoryKeys>;
}

function world(backend: VaultBackend, map = MAP): World {
  return {
    disk: memoryFiles({ "/work/billing/keypin.toml": map }),
    backend,
    keys: memoryKeys(["re-old"]),
  };
}

function rotation(at: World, answers: string[] = []) {
  const requests: string[] = [];
  const resend = resendFetch({ tokenPrefix: "re_new_", keys: at.keys, effect: () => undefined });
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

    at.disk.contents.set("/work/billing/keypin.toml", WITH_WORKER);
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

  test("--plan after an approved Infisical change writes nothing, and the rerun finishes", async () => {
    const infisical: FakeInfisical = {
      organization: "acme",
      projects: {
        mailer: {
          prod: {
            RESEND_API_KEY: { value: OLD, rotated: "2026-08-01" },
            RESEND_ADMIN_KEY: { value: ADMIN },
          },
        },
      },
    };
    const store = memoryStore();
    const backend = infisicalBackend(
      { clientId: "client-id-1", clientSecret: "client-secret-4e7b" },
      infisicalFetch(infisical, store),
    );
    const at = world(backend, INFISICAL_MAP);
    expect(await rotation(at, ["y"]).run()).toBe(0);
    infisical.heldByPolicy = [];
    expect(await rotation(at, ["y"]).run()).toBe(NEEDS_APPROVAL);
    mergeHeld(infisical, store);

    const before = at.disk.contents.get(STATE);
    const plan = rotation(at, ["y", "y"]);
    expect(await plan.run("--plan")).toBe(NEEDS_APPROVAL);
    expect(plan.disk.contents.get(STATE), "--plan leaves the state file as it was").toBe(before);
    expect(plan.asked).toEqual([]);
    expect(plan.delivered(NEW(2))).toEqual([]);
    expect(plan.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);

    const finish = rotation(at, ["y", "y"]);
    expect(await finish.run()).toBe(0);
    expect(finish.delivered(NEW(2))).toEqual([GITHUB]);
    expect(finish.requests).toContain("DELETE /api-keys/re-new-1");
    expect(finish.live()).toEqual(["re-old", "re-new-2"]);
  });
});
