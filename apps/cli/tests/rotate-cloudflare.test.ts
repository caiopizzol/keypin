import { describe, expect, test } from "vite-plus/test";
import type { KeyRef, VaultBackend } from "@keypin/core";
import { day } from "@keypin/core/testing";
import {
  type FakeToken,
  type FakeTokens,
  memoryTokens,
  tokensFetch,
} from "@keypin/connectors/cloudflare/testing";
import { onePasswordRef } from "@keypin/connectors/onepassword";
import { cli } from "../src/cli";
import { issuer as connect } from "../src/start";
import { fakeDeps, memoryFiles, writableVault } from "./fakes";
import { recording } from "./recording";

const DEPLOY = "cfut_deploysentineldeploysentinel0000000_1a2b";
const MAKER = "cfut_makersentinelmakersentinel000000000_3c4d";
const ITEM = "deploy cloudflare token";
const MAP_FILE = "/work/site/secretspec.toml";

const MAP = `
[project]
name = "site"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Site"

[defaults]
providers = ["vault"]

[profiles.prod]
CLOUDFLARE_API_TOKEN = { description = "deploys the site", ref = { item = "${ITEM}", field = "credential" } }

[tool.keypin.prod.CLOUDFLARE_API_TOKEN]
rotate_every = "25d"
issuer = { kind = "cloudflare", admin = "op://Site/cloudflare token maker/credential" }
`;

const group = (id: string, name: string) => ({ id, name, meta: {} });
const policy = (...groups: ReturnType<typeof group>[]) => ({
  id: "f267e341f3dd4697bd3b9f71dd96247f",
  effect: "allow",
  resources: { "com.cloudflare.api.account.0123456789abcdef0123456789abcdef": "*" },
  permission_groups: groups,
});
const EDITOR = group("e086da7e2179491d91ee5f35b3ca210a", "Workers Scripts Write");

function world(token: Partial<FakeToken> = {}, fake: Partial<FakeTokens> = {}) {
  const tokens = memoryTokens([
    {
      id: "a".repeat(32),
      name: "deploy",
      value: DEPLOY,
      policies: [policy(EDITOR)],
      issued_on: "2026-11-01T12:00:00Z",
      expires_on: "2026-12-01T12:00:00Z",
      ...token,
    },
  ]);
  const effects: string[] = [];
  const fetch = tokensFetch({
    admin: MAKER,
    valuePrefix: "cfut_issuedsentinel_",
    world: tokens,
    effect: (line) => void effects.push(line),
    ...fake,
  });
  const inner = writableVault({ [ITEM]: DEPLOY, "cloudflare token maker": MAKER });
  const dates = new Map([[ITEM, "2026-11-01"]]);
  const item = (ref: KeyRef) => onePasswordRef(ref)?.item ?? "";
  const vault: VaultBackend = {
    ...inner.vault,
    async metadata(ref) {
      const found = dates.get(item(ref));
      return { rotated: found === undefined ? null : day(found) };
    },
  };
  const fakes = fakeDeps({
    disk: memoryFiles({ [MAP_FILE]: MAP }),
    backend: vault,
    deps: {
      cwd: "/work/site",
      isTerminal: false,
      issuer: (spec, admin) => connect(spec, admin, fetch),
    },
  });
  const run = async (name: string, ...argv: string[]) => {
    const exit = await cli(["rotate", ...argv], fakes.deps);
    await expect(
      recording({
        args: ["rotate", ...argv],
        exit,
        stdout: fakes.stdout.text,
        stderr: fakes.stderr.text,
        calls: { "runner warnings": fakes.warnings, vault: inner.log },
      }),
    ).toMatchFileSnapshot(`./recordings/rotate-cloudflare/${name}.txt`);
    return exit;
  };
  return { ...fakes, run, effects, log: inner.log };
}

describe("a Cloudflare key rotated on a schedule", () => {
  test("an admin token that expires too close to the key's due date fails --due, on a day nothing is due", async () => {
    const w = world({}, { adminExpires: "2026-11-30T00:00:00Z" });
    expect(await w.run("admin-expires-before-due", "--due")).toBe(1);
    expect(w.stderr.text).toContain(
      "FAILED CLOUDFLARE_API_TOKEN (prod): the Cloudflare admin token expires 2026-11-30, in 20 days, too close to when CLOUDFLARE_API_TOKEN (prod) is due (2026-11-26). Renew it:",
    );
    expect(w.effects).toEqual([]);
    expect(w.log).not.toContain(`read ${ITEM}`);
  });

  test("an admin token that outlasts the due date is listed, and --due passes", async () => {
    const w = world({}, { adminExpires: "2027-03-01T00:00:00Z" });
    expect(await cli(["rotate", "--due"], w.deps)).toBe(0);
    expect(w.stderr.text).toContain(
      "  CLOUDFLARE_API_TOKEN (prod): the Cloudflare admin token expires 2027-03-01, in 111 days\n",
    );
  });

  test("--check fails when a new token wouldn't outlast rotate_every, and names broad permissions", async () => {
    const admin = group("1af1fa2adc104452b74a9a3364202f20", "Workers Admin");
    const w = world({ policies: [policy(EDITOR, admin)], expires_on: "2026-11-21T12:00:00Z" });
    expect(await w.run("lifetime-under-rotate-every", "--check")).toBe(1);
    expect(w.stderr.text).toContain(
      "FAILED CLOUDFLARE_API_TOKEN (prod): a new key lasts 20 days, and rotate_every is 25d, so the published key would expire before the next rotation.",
    );
    expect(w.stderr.text).toContain('the new token copies Workers Admin from token "deploy".');
    expect(w.effects).toEqual([]);
  });

  test("--check passes when a new token outlasts rotate_every, and the plan names the permissions it copies", async () => {
    const w = world();
    expect(await cli(["rotate", "--check"], w.deps), w.stderr.text).toBe(0);
    expect(w.stderr.text).toContain(
      "CLOUDFLARE_API_TOKEN (prod) is ready for keypin rotate --due.",
    );
    const plan = world();
    await plan.run("plan-names-permissions", "CLOUDFLARE_API_TOKEN", "--plan");
    expect(plan.stderr.text).toContain(
      "with the old token's 1 policy (Workers Scripts Write); expiring 30 days after it starts",
    );
    expect(plan.effects).toEqual([]);
  });
});
