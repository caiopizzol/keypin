import { describe, expect, test } from "vite-plus/test";
import { connectIssuer, type IssuerKind, type IssuerSpec, loadState, Secret } from "@keypin/core";
import { memoryKeys, resendFetch } from "@keypin/connectors/resend/testing";
import { cli } from "../src/cli";
import { issuer, issuers, vaults } from "../src/start";
import { fakeDeps, fakeDestinations, memoryFiles, STATE, writableVault } from "./fakes";

type ForgeSpec = IssuerSpec & { kind: "forge"; scope: string };

const log: string[] = [];

const forge: IssuerKind<ForgeSpec> = {
  kind: "forge",
  parse(read) {
    read.only(["scope"]);
    const admin = read.admin();
    const scope = read.required("scope");
    return admin && scope !== undefined ? { kind: "forge", admin, scope } : undefined;
  },
  connect: ({ scope }, admin) => ({
    describe: () => "Forge",
    dashboard: () => "https://forge.example/keys",
    checkAccount: async (current) => {
      log.push(`check ${current ?? "none"} as ${admin.reveal()}`);
      return { ok: true, facts: `the ${scope} scope` };
    },
    create: async (name) => {
      log.push(`create ${name} in ${scope}`);
      return { id: "forge-1", secret: new Secret("forge-new-value") };
    },
    revoke: async (id) => {
      log.push(`revoke ${id}`);
      return "revoked";
    },
  }),
};

const MAP = `
[1password]
account = "my.1password.com"

[keys.FORGE_TOKEN.prod]
from = "op://Private/forge token/credential"
publish = [{ to = "github-actions", repo = "acme/forge" }]
issuer = { kind = "forge", admin = "op://Private/forge admin/credential", scope = "deploy" }
`;

const RESEND_MAP = `
[1password]
account = "my.1password.com"

[keys.MAILER_KEY.prod]
from = "op://Private/mailer key/credential"
publish = [{ to = "github-actions", repo = "acme/mailer" }]
issuer = { kind = "resend", admin = "op://Private/resend admin/credential", permission = "full_access" }
`;

describe("an issuer kind defined outside keypin", () => {
  test("parses from keypin.toml, rotates through its own issuer and records its kind", async () => {
    log.length = 0;
    const kinds = [...issuers, forge];
    const disk = memoryFiles({ "/work/billing/keypin.toml": MAP });
    const vault = writableVault({ "forge token": "forge-old-value", "forge admin": "forge-admin" });
    const fake = fakeDeps({
      disk,
      backend: vault.vault,
      deps: {
        issuers: kinds,
        issuer: (spec, admin) => connectIssuer(kinds, spec, admin),
        destination: fakeDestinations().build,
        isTerminal: true,
        ask: async () => "y",
      },
    });
    expect(await cli(["rotate", "FORGE_TOKEN"], fake.deps)).toBe(0);
    expect(log).toEqual([
      "check none as forge-admin",
      "create FORGE_TOKEN prod 2026-11-09 12:00:00 a1b2c3 in deploy",
    ]);
    expect(vault.values.get("forge token")).toBe("forge-new-value");
    const { issued } = await loadState(disk.files, STATE, vaults);
    expect(issued.map((i) => [i.issuer, i.id])).toEqual([["forge", "forge-1"]]);
  });

  test("an unknown kind lists the kinds keypin has", async () => {
    const fake = fakeDeps({ disk: memoryFiles({ "/work/billing/keypin.toml": MAP }) });
    await cli(["rotate", "FORGE_TOKEN"], fake.deps);
    expect(fake.stderr.text).toContain(
      `issuer: field "kind" must be one of: resend, neon, openai, supabase, cloudflare, openrouter, google, elevenlabs, aws, sendgrid`,
    );
  });
});

describe("the issuer keypin connects", () => {
  test("is the one for the spec's kind", () => {
    const admin = {
      kind: "1password",
      account: "a",
      vault: "v",
      item: "i",
      section: null,
      field: "f",
    } as const;
    const spec: ForgeSpec = { kind: "forge", admin, scope: "deploy" };
    expect(connectIssuer([...issuers, forge], spec, new Secret("x")).describe()).toBe("Forge");
    expect(() => issuer(spec, new Secret("x"))).toThrow(`keypin has no issuer kind "forge"`);
  });

  test("a Resend rotation saves issuer resend and Resend's key id in state.json", async () => {
    const disk = memoryFiles({ "/work/billing/keypin.toml": RESEND_MAP });
    const vault = writableVault({ "mailer key": "re_old", "resend admin": "re_admin" });
    const fetch = resendFetch({
      tokenPrefix: "re_new_",
      keys: memoryKeys(["re-old"]),
      effect: () => {},
    });
    const fake = fakeDeps({
      disk,
      backend: vault.vault,
      deps: {
        issuer: (spec, admin) => issuer(spec, admin, fetch),
        destination: fakeDestinations().build,
        isTerminal: true,
        ask: async () => "y",
      },
    });
    expect(await cli(["rotate", "MAILER_KEY"], fake.deps)).toBe(0);
    const { issued } = await loadState(disk.files, STATE, vaults);
    expect(issued.map((i) => [i.issuer, i.id])).toEqual([["resend", "re-new-1"]]);
  });
});
