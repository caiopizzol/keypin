import { assert, describe, expect, test } from "vite-plus/test";
import { isRecord } from "@keypin/core";
import { credentialsFrom, infisicalBackend } from "@keypin/vault-infisical";
import { infisicalFetch, memoryStore } from "@keypin/vault-infisical/testing";
import { cli } from "../src/cli";
import { routedVault } from "../src/vault";
import {
  fakeDeps,
  fakeDestinations,
  fakeVault,
  memoryFiles,
  REGISTRY,
  registryWith,
  SENTINEL,
  STATE,
} from "./fakes";

const MAP_FILE = "/work/billing/keypin.toml";
const PUBLISH = `publish = [{ to = "github-actions", repo = "acme/billing" }]`;

const MAP = `
[1password]
account = "my.1password.com"

[infisical]
organization = "acme"
url = "https://eu.infisical.com/"

[keys.PLAIN_KEY]
prod = { from = "op://Private/plain key/password", ${PUBLISH} }

[keys.SECTION_KEY]
prod = { from = "op://Private/section key/api/credential", ${PUBLISH} }

[keys.ROOT_KEY]
prod = { from = "infisical://billing/prod/ROOT_KEY", ${PUBLISH} }

[keys.FOLDER_KEY]
prod = { from = "infisical://billing/prod/payments/stripe/FOLDER_KEY", ${PUBLISH} }
`;

const FRESH: Record<string, string> = {
  PLAIN_KEY:
    '{"kind":"1password","vault":"Private","item":"plain key","section":null,"field":"password","account":"my.1password.com"}',
  SECTION_KEY:
    '{"kind":"1password","vault":"Private","item":"section key","section":"api","field":"credential","account":"my.1password.com"}',
  ROOT_KEY:
    '{"kind":"infisical","project":"billing","environment":"prod","path":"/","name":"ROOT_KEY","url":"https://eu.infisical.com","organization":"acme"}',
  FOLDER_KEY:
    '{"kind":"infisical","project":"billing","environment":"prod","path":"/payments/stripe","name":"FOLDER_KEY","url":"https://eu.infisical.com","organization":"acme"}',
};

const STORED: Record<string, string> = {
  PLAIN_KEY:
    '{"kind":"1password","account":"my.1password.com","vault":"Private","item":"plain key","section":null,"field":"password"}',
  SECTION_KEY:
    '{"kind":"1password","account":"my.1password.com","vault":"Private","item":"section key","section":"api","field":"credential"}',
  ROOT_KEY:
    '{"kind":"infisical","url":"https://eu.infisical.com","organization":"acme","project":"billing","environment":"prod","path":"/","name":"ROOT_KEY"}',
  FOLDER_KEY:
    '{"kind":"infisical","url":"https://eu.infisical.com","organization":"acme","project":"billing","environment":"prod","path":"/payments/stripe","name":"FOLDER_KEY"}',
};

const KEYS = Object.keys(FRESH);

const SOURCE_IDS: Record<string, string> = {
  PLAIN_KEY: '{"vault":"id-private","item":"id-plain key"}',
  SECTION_KEY: '{"vault":"id-private","item":"id-section key"}',
  ROOT_KEY: '{"vault":"billing","item":"billing/prod/ROOT_KEY"}',
  FOLDER_KEY: '{"vault":"billing","item":"billing/prod/FOLDER_KEY"}',
};

function setup(initial: Record<string, string> = {}, changed = "") {
  const disk = memoryFiles({
    [MAP_FILE]: MAP,
    [REGISTRY]: registryWith("/work/billing"),
    ...initial,
  });
  const env = {
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "client-id-1",
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "client-secret-1",
  };
  const onePassword = fakeVault({
    values: { "plain key": `${SENTINEL}${changed}`, "section key": `${SENTINEL}-section` },
  });
  const infisical = infisicalBackend(
    credentialsFrom(env),
    infisicalFetch(
      {
        organization: "acme",
        projects: {
          billing: {
            prod: {
              ROOT_KEY: { value: `${SENTINEL}-root${changed}` },
              "/payments/stripe/FOLDER_KEY": { value: `${SENTINEL}-folder` },
            },
          },
        },
      },
      memoryStore(),
    ),
  );
  const fake = fakeDeps({
    disk,
    backend: routedVault({ "1password": () => onePassword.vault, infisical: () => infisical }),
    deps: { env, destination: fakeDestinations().build, isTerminal: true, ask: async () => "y" },
  });
  return { ...fake, disk };
}

function savedReceipts(text: string | undefined): Record<string, unknown>[] {
  assert(text !== undefined);
  const data: unknown = JSON.parse(text);
  assert(isRecord(data) && Array.isArray(data.receipts));
  return data.receipts.filter(isRecord);
}

const pinned = (receipts: Record<string, unknown>[], field: "source" | "sourceIds") =>
  Object.fromEntries(receipts.map((r) => [String(r.keyId), JSON.stringify(r[field])]));

describe("the vault references keypin saves in state.json never change", () => {
  test.each(KEYS)("publish saves %s's reference and item IDs in the same JSON", async (key) => {
    const run = setup();
    expect(await cli(["publish", key], run.deps)).toBe(0);
    const receipts = savedReceipts(run.disk.contents.get(STATE));
    expect(pinned(receipts, "source")).toEqual({ [key]: FRESH[key] });
    expect(pinned(receipts, "sourceIds")).toEqual({ [key]: SOURCE_IDS[key] });
  });

  test("a saved state loads, matches the map, and saves its references again in the stored order", async () => {
    const first = setup();
    for (const key of KEYS) expect(await cli(["publish", key], first.deps)).toBe(0);
    const saved = first.disk.contents.get(STATE);
    assert(saved !== undefined);
    expect(pinned(savedReceipts(saved), "source")).toEqual({
      ...STORED,
      FOLDER_KEY: FRESH.FOLDER_KEY,
    });

    const again = setup({ [STATE]: saved }, "-new");
    for (const key of KEYS) expect(await cli(["publish", key], again.deps)).toBe(0);
    expect(again.stderr.text).not.toContain("was last published from");
    const resaved = savedReceipts(again.disk.contents.get(STATE));
    expect(pinned(resaved, "source")).toEqual({ ...STORED, ROOT_KEY: FRESH.ROOT_KEY });
    expect(pinned(resaved, "sourceIds")).toEqual(SOURCE_IDS);
  });

  test("an older 1Password reference with no section or field reads as the password field", async () => {
    const old = {
      keyId: "PLAIN_KEY",
      environment: "prod",
      mapFile: MAP_FILE,
      source: {
        kind: "1password",
        account: "my.1password.com",
        vault: "Private",
        item: "plain key",
      },
      destinationId: "github-actions:acme/billing:PLAIN_KEY",
      generation: "0000000000000000",
      account: { pinned: "acme", publisher: "acme", destinationAccount: "acme" },
      at: "2026-11-01T00:00:00Z",
      evidence: {},
    };
    const run = setup({
      [STATE]: JSON.stringify({ version: 3, receipts: [old], operations: [] }),
    });
    expect(await cli(["publish", "PLAIN_KEY"], run.deps)).toBe(0);
    expect(run.stderr.text).not.toContain("was last published from");
    expect(run.stderr.text).toMatch(/~ GitHub +acme\/billing +new value\n/);
    expect(pinned(savedReceipts(run.disk.contents.get(STATE)), "source")).toEqual({
      PLAIN_KEY: FRESH.PLAIN_KEY,
    });
  });
});
