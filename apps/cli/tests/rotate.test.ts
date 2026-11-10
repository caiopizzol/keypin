import { describe, expect, test } from "vite-plus/test";
import {
  generationOf,
  type KeyRef,
  loadRotations,
  loadState,
  type ProviderToken,
  type Receipt,
  Secret,
  type TokenProvider,
  type VaultBackend,
} from "@keypin/core";
import { cli } from "../src/cli";
import { nextName } from "../src/commands/rotate";
import {
  fakeDeps,
  fakeDestinations,
  type FakeDestinationOptions,
  memoryFiles,
  REGISTRY,
  registryWith,
  STATE,
} from "./fakes";

const ROTATIONS = "/home/me/.local/state/keypin/rotations.json";
const ACCOUNT = "e48c9afabc4ff0cda321d0cf69b8943f";
const OLD_ID = "a".repeat(32);
const NEW_ID = "b".repeat(32);
const OLD_VALUE = "cfat_old-sentinel-4e1a";
const NEW_VALUE = "cfat_new-sentinel-90bd";
const ADMIN_VALUE = "cfat_admin-sentinel-3f27";
const ITEM = "site deploy token";
const ADMIN_ITEM = "shared cloudflare token admin";
const GITHUB = "github-actions:acme/site:CLOUDFLARE_API_TOKEN";

const MAP = `
[vaults.personal]
kind = "1password"
account = "my.1password.com"
vault = "App Secrets"

[keys.site-deploy]
env = "CLOUDFLARE_API_TOKEN"
owner = "site"
rotate_every = "90d"

[keys.site-deploy.prod]
vault = "personal"
item = "${ITEM}"

[[keys.site-deploy.prod.publish]]
to = "github-actions"
repo = "acme/site"

[keys.site-deploy.prod.issue]
provider = "cloudflare-account-token"
account = "${ACCOUNT}"
admin = "${ADMIN_ITEM}"
`;

const POLICIES = [
  {
    effect: "allow",
    resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
    permissionGroups: [{ id: "98d78cd2433d4c3687191bc0244ef948", name: "Workers Admin" }],
  },
];

const OLD_TOKEN: ProviderToken = {
  id: OLD_ID,
  name: "cicd-keypin",
  status: "active",
  expiresOn: "2027-02-09T02:59:59Z",
  lastUsedOn: "2026-11-10T14:54:43Z",
  policies: POLICIES,
  condition: null,
};

interface ProviderOptions {
  refuse?: boolean;
  verifyAs?: string;
  otherPolicies?: boolean;
  revokeFails?: boolean;
}

function fakeProvider(options: ProviderOptions = {}) {
  const log: string[] = [];
  const tokens = new Map<string, ProviderToken & { value: string }>([
    [OLD_ID, { ...OLD_TOKEN, value: OLD_VALUE }],
  ]);
  const admins: string[] = [];
  const build = (_issue: unknown, admin: Secret): TokenProvider => {
    admins.push(admin.reveal());
    return {
      describe: () => "fake",
      async verify(secret) {
        log.push("verify");
        const found = [...tokens.values()].find((t) => t.value === secret.reveal());
        if (!found) throw new Error("HTTP 401");
        return {
          id: options.verifyAs && found.id === NEW_ID ? options.verifyAs : found.id,
          status: found.status,
          expiresOn: found.expiresOn,
        };
      },
      async details(id) {
        log.push(`details ${id.slice(0, 4)}`);
        const found = tokens.get(id);
        if (!found) return null;
        const { value: _value, ...token } = found;
        return token;
      },
      async issue(request) {
        log.push(`issue "${request.name}" until ${request.expiresOn}`);
        if (options.refuse) return { refused: "Cloudflare POST returned HTTP 403" };
        const policies = options.otherPolicies ? [] : request.like.policies;
        const token = {
          id: NEW_ID,
          name: request.name,
          status: "active",
          expiresOn: request.expiresOn,
          lastUsedOn: null,
          policies,
          condition: request.like.condition,
        };
        tokens.set(NEW_ID, { ...token, value: NEW_VALUE });
        return { token, value: new Secret(NEW_VALUE) };
      },
      async revoke(id) {
        log.push(`revoke ${id.slice(0, 4)}`);
        if (options.revokeFails) throw new Error("HTTP 500");
        return tokens.delete(id) ? "revoked" : "already gone";
      },
    };
  };
  return { build, log, tokens, admins };
}

function writableVault(options: { failWrite?: boolean; rotateEvery?: string | null } = {}) {
  const values = new Map([
    [ITEM, OLD_VALUE],
    [ADMIN_ITEM, ADMIN_VALUE],
  ]);
  const calls: string[] = [];
  const vault: VaultBackend = {
    capabilities: { read: true, write: true, list: false, metadata: true },
    async read(ref: KeyRef) {
      calls.push(`read ${ref.item}`);
      const value = values.get(ref.item);
      if (value === undefined) throw new Error(`no item "${ref.item}"`);
      return new Secret(value);
    },
    async write(ref, secret, writeOptions) {
      calls.push(`write ${ref.item} rotated ${writeOptions?.rotated}`);
      if (options.failWrite) throw new Error("1Password is locked");
      values.set(ref.item, secret.reveal());
    },
    async list() {
      throw new Error("no list");
    },
    async metadata(ref) {
      calls.push(`metadata ${ref.item}`);
      return { rotated: "2026-11-10", rotateEvery: options.rotateEvery ?? null };
    },
  };
  return { vault, calls, values };
}

async function receiptFor(value: string, at = "2026-11-10T14:52:03.000Z"): Promise<Receipt> {
  return {
    keyId: "site-deploy",
    environment: "prod",
    source: { kind: "1password", account: "my.1password.com", vault: "App Secrets", item: ITEM },
    destinationId: GITHUB,
    generation: await generationOf(new Secret(value)),
    account: { pinned: "acme", publisher: "acme", destinationAccount: "acme" },
    at,
    evidence: {},
  };
}

async function setup(
  options: {
    provider?: ProviderOptions;
    destinations?: FakeDestinationOptions;
    vault?: Parameters<typeof writableVault>[0];
    terminal?: string[];
    map?: string;
    receipts?: Receipt[] | null;
    disk?: ReturnType<typeof memoryFiles>;
  } = {},
) {
  const receipts =
    options.receipts === undefined ? [await receiptFor(OLD_VALUE)] : options.receipts;
  const disk =
    options.disk ??
    memoryFiles({
      "/work/billing/keypin.toml": options.map ?? MAP,
      ...(receipts ? { [STATE]: JSON.stringify({ version: 2, receipts, operations: [] }) } : {}),
    });
  const provider = fakeProvider(options.provider);
  const vault = writableVault(options.vault);
  const destinations = fakeDestinations(options.destinations);
  const answers = [...(options.terminal ?? [])];
  const asked: string[] = [];
  const fake = fakeDeps({
    disk,
    backend: vault.vault,
    deps: {
      destination: destinations.build,
      provider: provider.build,
      isTerminal: options.terminal !== undefined,
      now: () => new Date(2026, 10, 10, 12, 0, 0),
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
    },
  });
  const rotations = () => loadRotations(disk.files, ROTATIONS);
  const state = () => loadState(disk.files, STATE);
  const leaked = () =>
    [fake.stdout.text, fake.stderr.text, ...disk.contents.values()].some((text) =>
      [OLD_VALUE, NEW_VALUE, ADMIN_VALUE].some((value) => text.includes(value)),
    );
  return { ...fake, disk, provider, vault, destinations, asked, rotations, state, leaked };
}

const NEW_GENERATION = await generationOf(new Secret(NEW_VALUE));
const OLD_GENERATION = await generationOf(new Secret(OLD_VALUE));

describe("keypin rotate: the first run", () => {
  test("issues, checks, stores and publishes the new token, and leaves the old one active", async () => {
    const run = await setup({ terminal: ["yes"] });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(0);

    expect(run.provider.log).toEqual([
      "verify",
      `details ${OLD_ID.slice(0, 4)}`,
      `issue "cicd-keypin 2026-11-10" until 2027-02-22T23:59:59Z`,
      "verify",
      `details ${NEW_ID.slice(0, 4)}`,
    ]);
    expect(run.provider.admins).toEqual([ADMIN_VALUE]);
    expect(run.provider.tokens.has(OLD_ID)).toBe(true);
    expect(run.vault.values.get(ITEM)).toBe(NEW_VALUE);
    expect(run.vault.calls).toContain(`write ${ITEM} rotated 2026-11-10`);
    expect(run.destinations.log).toEqual([
      "check github-actions:acme/site",
      `write github-actions:acme/site CLOUDFLARE_API_TOKEN (${NEW_VALUE.length} chars)`,
    ]);

    const state = await run.state();
    expect(state.receipts.map((r) => r.generation)).toEqual([NEW_GENERATION]);
    expect(state.operations).toEqual([]);
    expect((await run.rotations()).rotations).toEqual([
      expect.objectContaining({
        stage: "published",
        keyId: "site-deploy",
        old: {
          id: OLD_ID,
          name: "cicd-keypin",
          expiresOn: "2027-02-09T02:59:59Z",
          generation: OLD_GENERATION,
        },
        new: {
          id: NEW_ID,
          name: "cicd-keypin 2026-11-10",
          expiresOn: "2027-02-22T23:59:59Z",
          generation: NEW_GENERATION,
        },
      }),
    ]);

    expect(run.asked).toEqual(["Type yes to make the new token: "]);
    expect(run.stderr.text).toContain(
      `current token: ${OLD_ID} "cicd-keypin", active, expires 2027-02-09T02:59:59Z`,
    );
    expect(run.stderr.text).toContain(
      `new token: "cicd-keypin 2026-11-10", expires 2027-02-22T23:59:59Z (rotate_every 90d plus 14 days' grace)`,
    );
    expect(run.stderr.text).toContain("allow Workers Admin");
    expect(run.stderr.text).toContain(`on com.cloudflare.api.account.${ACCOUNT}: "*"`);
    expect(run.stderr.text).toContain(`store in: item "${ITEM}", with rotated 2026-11-10`);
    expect(run.stderr.text).toContain(`publish to: ${GITHUB} (account acme)`);
    expect(run.stderr.text).toContain(`The old token ${OLD_ID} "cicd-keypin" is still active.`);
    expect(run.stderr.text).toContain(
      "Then run keypin rotate site-deploy again to revoke the old token.",
    );
    expect(run.leaked()).toBe(false);
  });

  test("the expiry falls back to the item's rotate_every", async () => {
    const run = await setup({
      terminal: ["yes"],
      map: MAP.replace(`rotate_every = "90d"\n`, ""),
      vault: { rotateEvery: "30d" },
    });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(0);
    expect(run.provider.log).toContain(`issue "cicd-keypin 2026-11-10" until 2026-12-24T23:59:59Z`);
  });

  test("without a rotation period it stops before making anything", async () => {
    const run = await setup({ terminal: ["yes"], map: MAP.replace(`rotate_every = "90d"\n`, "") });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("rotate_every is missing");
    expect(run.provider.log).toEqual([]);
  });

  test("--yes runs without a terminal when publishing needs no approval", async () => {
    const run = await setup({});
    expect(await cli(["rotate", "site-deploy", "--yes"], run.deps)).toBe(0);
    expect((await run.rotations()).rotations[0]?.stage).toBe("published");
  });

  test("without a terminal or --yes it stops before reading anything", async () => {
    const run = await setup({});
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(2);
    expect(run.vault.calls).toEqual([]);
    expect(run.provider.log).toEqual([]);
    expect(run.stderr.text).toContain("rotate site-deploy");
    expect(run.disk.contents.has(ROTATIONS)).toBe(false);
  });

  test("--yes can't approve a first write to a destination", async () => {
    const run = await setup({ receipts: null });
    expect(await cli(["rotate", "site-deploy", "--yes"], run.deps)).toBe(2);
    expect(run.stderr.text).toContain(`needs approval: first write to ${GITHUB}`);
    expect(run.vault.calls).toEqual([]);
  });

  test("answering anything but yes changes nothing", async () => {
    const run = await setup({ terminal: ["no"] });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(2);
    expect(run.provider.log).not.toContainEqual(expect.stringMatching(/^issue/));
    expect(run.disk.contents.has(ROTATIONS)).toBe(false);
  });

  test("a failed account check stops before reading anything", async () => {
    const run = await setup({
      terminal: ["yes"],
      destinations: { badAccount: ["github-actions:acme/site"] },
    });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect(run.vault.calls).toEqual([]);
  });

  test("a key without an issue section is refused", async () => {
    const run = await setup({
      terminal: ["yes"],
      map: MAP.replace(/\[keys\.site-deploy\.prod\.issue\][^]*$/, ""),
    });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("has no [keys.site-deploy.prod.issue] section");
  });

  test("a refused create leaves nothing behind", async () => {
    const run = await setup({ terminal: ["yes"], provider: { refuse: true } });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("No token was made");
    expect((await run.rotations()).rotations).toEqual([]);
    expect(run.vault.values.get(ITEM)).toBe(OLD_VALUE);
  });

  test.each([
    [{ verifyAs: "c".repeat(32) }, `verifies as token ${"c".repeat(32)}`],
    [{ otherPolicies: true }, `policies differ from ${OLD_ID}'s`],
  ])(
    "a new token that fails its check is deleted, and nothing else changes (%o)",
    async (provider, reason) => {
      const run = await setup({ terminal: ["yes"], provider });
      expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
      expect(run.stderr.text).toContain(reason);
      expect(run.provider.log).toContain(`revoke ${NEW_ID.slice(0, 4)}`);
      expect(run.provider.tokens.has(NEW_ID)).toBe(false);
      expect(run.provider.tokens.has(OLD_ID)).toBe(true);
      expect(run.vault.calls.some((c) => c.startsWith("write"))).toBe(false);
      expect(run.destinations.log).toEqual(["check github-actions:acme/site"]);
      expect((await run.rotations()).rotations).toEqual([]);
      expect(run.leaked()).toBe(false);
    },
  );

  test("if deleting the failed token fails too, the rotation stays issued for the next run", async () => {
    const run = await setup({
      terminal: ["yes"],
      provider: { otherPolicies: true, revokeFails: true },
    });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect((await run.rotations()).rotations[0]?.stage).toBe("issued");
  });

  test("a failed vault write keeps the issued stage, and the next run offers to delete the new token", async () => {
    const disk = memoryFiles({
      "/work/billing/keypin.toml": MAP,
      [STATE]: JSON.stringify({
        version: 2,
        receipts: [await receiptFor(OLD_VALUE)],
        operations: [],
      }),
    });
    const first = await setup({ terminal: ["yes"], vault: { failWrite: true }, disk });
    expect(await cli(["rotate", "site-deploy"], first.deps)).toBe(1);
    expect(first.stderr.text).toContain("1Password is locked");
    expect((await first.rotations()).rotations[0]?.stage).toBe("issued");
    expect(first.destinations.log).toEqual(["check github-actions:acme/site"]);

    const second = await setup({ terminal: ["yes"], disk });
    second.provider.tokens.set(NEW_ID, {
      ...OLD_TOKEN,
      id: NEW_ID,
      name: "cicd-keypin 2026-11-10",
      value: NEW_VALUE,
    });
    expect(await cli(["rotate", "site-deploy"], second.deps)).toBe(1);
    expect(second.asked).toEqual([`Type yes to delete the new token ${NEW_ID}: `]);
    expect(second.provider.log).toContain(`revoke ${NEW_ID.slice(0, 4)}`);
    expect(second.provider.tokens.has(OLD_ID)).toBe(true);
    expect((await second.rotations()).rotations).toEqual([]);
  });
});

describe("keypin rotate: the next run", () => {
  async function published() {
    const disk = memoryFiles({
      "/work/billing/keypin.toml": MAP,
      [STATE]: JSON.stringify({
        version: 2,
        receipts: [await receiptFor(OLD_VALUE)],
        operations: [],
      }),
    });
    const first = await setup({ terminal: ["yes"], disk });
    expect(await cli(["rotate", "site-deploy"], first.deps)).toBe(0);
    return disk;
  }

  async function next(disk: ReturnType<typeof memoryFiles>, terminal?: string[]) {
    const run = await setup({ terminal, disk });
    run.provider.tokens.set(NEW_ID, {
      ...OLD_TOKEN,
      id: NEW_ID,
      name: "cicd-keypin 2026-11-10",
      lastUsedOn: null,
      value: NEW_VALUE,
    });
    run.vault.values.set(ITEM, NEW_VALUE);
    return run;
  }

  test("shows the old token with last_used_on, and revokes it after a typed yes", async () => {
    const disk = await published();
    const run = await next(disk, ["yes"]);
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain(
      `Every destination's receipt has generation ${NEW_GENERATION}.`,
    );
    expect(run.stderr.text).toContain(`Old token: ${OLD_ID} "cicd-keypin", active`);
    expect(run.stderr.text).toContain("last used: 2026-11-10T14:54:43Z");
    expect(run.asked).toEqual([`Type yes to revoke the old token ${OLD_ID}: `]);
    expect(run.provider.log).toContain(`revoke ${OLD_ID.slice(0, 4)}`);
    expect(run.provider.tokens.has(OLD_ID)).toBe(false);
    expect((await run.rotations()).rotations[0]?.stage).toBe("revoked");
    expect(run.vault.calls).toEqual([`read ${ADMIN_ITEM}`]);
    expect(run.leaked()).toBe(false);
  });

  test("--yes can't revoke, and without a terminal nothing is read", async () => {
    const disk = await published();
    const run = await next(disk);
    expect(await cli(["rotate", "site-deploy", "--yes"], run.deps)).toBe(2);
    expect(run.stderr.text).toContain(
      "revoking needs yes typed in a terminal, and --yes can't give it",
    );
    expect(run.vault.calls).toEqual([]);
    expect(run.provider.tokens.has(OLD_ID)).toBe(true);
  });

  test("anything but yes keeps the old token", async () => {
    const disk = await published();
    const run = await next(disk, ["y"]);
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(2);
    expect(run.provider.tokens.has(OLD_ID)).toBe(true);
    expect((await run.rotations()).rotations[0]?.stage).toBe("published");
  });

  test("a destination whose receipt lacks the new generation blocks the revoke", async () => {
    const disk = await published();
    const state = JSON.parse(disk.contents.get(STATE) ?? "{}");
    state.receipts = [await receiptFor(OLD_VALUE, "2026-11-10T20:00:00.000Z")];
    disk.contents.set(STATE, JSON.stringify(state));
    const run = await next(disk, ["yes"]);
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(`${GITHUB} doesn't have generation ${NEW_GENERATION}`);
    expect(run.asked).toEqual([]);
    expect(run.provider.tokens.has(OLD_ID)).toBe(true);
  });

  test("a new token that isn't active blocks the revoke", async () => {
    const disk = await published();
    const run = await next(disk, ["yes"]);
    run.provider.tokens.delete(NEW_ID);
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(`the new token ${NEW_ID} is gone`);
    expect(run.provider.tokens.has(OLD_ID)).toBe(true);
  });

  test("after the revoke, the next run starts a new rotation", async () => {
    const disk = await published();
    const revoke = await next(disk, ["yes"]);
    expect(await cli(["rotate", "site-deploy"], revoke.deps)).toBe(0);
    const again = await next(disk, ["no"]);
    expect(await cli(["rotate", "site-deploy"], again.deps)).toBe(2);
    expect(again.stderr.text).toContain("Plan:");
  });
});

describe("keypin rotate: the state file stays readable by keypin 0.1.0", () => {
  test("state.json keeps version 2 with only receipts and operations", async () => {
    const run = await setup({ terminal: ["yes"] });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(0);
    const state = JSON.parse(run.disk.contents.get(STATE) ?? "{}");
    expect(Object.keys(state).toSorted()).toEqual(["operations", "receipts", "version"]);
    expect(state.version).toBe(2);
    expect(run.disk.contents.has(ROTATIONS)).toBe(true);
  });
});

describe("nextName", () => {
  test.each([
    ["cicd-keypin", "cicd-keypin 2026-11-10"],
    ["cicd-keypin 2026-08-01", "cicd-keypin 2026-11-10"],
    ["cicd-keypin 2026-11-10", "cicd-keypin 2026-11-10 #2"],
    ["cicd-keypin 2026-11-10 #2", "cicd-keypin 2026-11-10 #3"],
  ])("%s becomes %s", (old, next) => {
    expect(nextName(old, "2026-11-10")).toBe(next);
  });
});

describe("keypin rotate: a run that stopped after storing", () => {
  test("re-checks the new token before publishing it", async () => {
    const disk = memoryFiles({
      "/work/billing/keypin.toml": MAP,
      [STATE]: JSON.stringify({
        version: 2,
        receipts: [await receiptFor(OLD_VALUE)],
        operations: [],
      }),
      [ROTATIONS]: JSON.stringify({
        version: 1,
        rotations: [
          {
            id: "r1",
            keyId: "site-deploy",
            environment: "prod",
            item: {
              kind: "1password",
              account: "my.1password.com",
              vault: "App Secrets",
              item: ITEM,
            },
            provider: "cloudflare-account-token",
            account: ACCOUNT,
            stage: "issued",
            startedAt: "2026-11-10T12:00:00.000Z",
            updatedAt: "2026-11-10T12:00:01.000Z",
            old: { id: OLD_ID, name: "cicd-keypin", expiresOn: null, generation: OLD_GENERATION },
            new: {
              id: NEW_ID,
              name: "cicd-keypin 2026-11-10",
              expiresOn: null,
              generation: NEW_GENERATION,
            },
          },
        ],
      }),
    });
    const good = await setup({ terminal: ["yes"], disk });
    good.vault.values.set(ITEM, NEW_VALUE);
    good.provider.tokens.set(NEW_ID, { ...OLD_TOKEN, id: NEW_ID, value: NEW_VALUE });
    expect(await cli(["rotate", "site-deploy"], good.deps)).toBe(0);
    expect(good.provider.log.slice(0, 3)).toEqual([
      `details ${OLD_ID.slice(0, 4)}`,
      "verify",
      `details ${NEW_ID.slice(0, 4)}`,
    ]);
    expect((await good.rotations()).rotations[0]?.stage).toBe("published");
  });

  test("refuses to publish a stored value whose token no longer matches", async () => {
    const disk = memoryFiles({
      "/work/billing/keypin.toml": MAP,
      [STATE]: JSON.stringify({
        version: 2,
        receipts: [await receiptFor(OLD_VALUE)],
        operations: [],
      }),
      [ROTATIONS]: JSON.stringify({
        version: 1,
        rotations: [
          {
            id: "r1",
            keyId: "site-deploy",
            environment: "prod",
            item: {
              kind: "1password",
              account: "my.1password.com",
              vault: "App Secrets",
              item: ITEM,
            },
            provider: "cloudflare-account-token",
            account: ACCOUNT,
            stage: "issued",
            startedAt: "2026-11-10T12:00:00.000Z",
            updatedAt: "2026-11-10T12:00:01.000Z",
            old: { id: OLD_ID, name: "cicd-keypin", expiresOn: null, generation: OLD_GENERATION },
            new: {
              id: NEW_ID,
              name: "cicd-keypin 2026-11-10",
              expiresOn: null,
              generation: NEW_GENERATION,
            },
          },
        ],
      }),
    });
    const bad = await setup({ terminal: ["yes"], disk });
    bad.vault.values.set(ITEM, NEW_VALUE);
    bad.provider.tokens.set(NEW_ID, { ...OLD_TOKEN, id: NEW_ID, policies: [], value: NEW_VALUE });
    expect(await cli(["rotate", "site-deploy"], bad.deps)).toBe(1);
    expect(bad.stderr.text).toContain(`policies differ from ${OLD_ID}'s`);
    expect(bad.destinations.log).toEqual(["check github-actions:acme/site"]);
    expect((await bad.rotations()).rotations[0]?.stage).toBe("stored");
  });
});

describe("keypin rotate: review fixes", () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    id: "r1",
    keyId: "site-deploy",
    environment: "prod",
    item: { kind: "1password", account: "my.1password.com", vault: "App Secrets", item: ITEM },
    provider: "cloudflare-account-token",
    account: ACCOUNT,
    stage: "stored",
    startedAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:01.000Z",
    old: { id: OLD_ID, name: "cicd-keypin", expiresOn: null, generation: OLD_GENERATION },
    new: {
      id: NEW_ID,
      name: "cicd-keypin 2026-11-10",
      expiresOn: null,
      generation: NEW_GENERATION,
    },
    ...overrides,
  });
  const diskWith = async (rotation: Record<string, unknown>, map = MAP) =>
    memoryFiles({
      "/work/billing/keypin.toml": map,
      [STATE]: JSON.stringify({
        version: 2,
        receipts: [await receiptFor(OLD_VALUE)],
        operations: [],
      }),
      [ROTATIONS]: JSON.stringify({ version: 1, rotations: [rotation] }),
    });

  test("a key with no destinations is refused before anything is read", async () => {
    const map = MAP.replace(
      /\[\[keys\.site-deploy\.prod\.publish\]\]\nto = "github-actions"\nrepo = "acme\/site"\n/,
      "",
    );
    const run = await setup({ terminal: ["yes"], map });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("lists no destinations");
    expect(run.vault.calls).toEqual([]);
    expect(run.provider.log).toEqual([]);
  });

  test("a stored rotation re-checks the new token before writing, and keeps its stage when it fails", async () => {
    const run = await setup({ terminal: ["yes"], disk: await diskWith(record()) });
    run.vault.values.set(ITEM, NEW_VALUE);
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain("HTTP 401");
    expect(run.destinations.log).toEqual(["check github-actions:acme/site"]);
    expect(run.provider.tokens.has(OLD_ID)).toBe(true);
    expect((await run.rotations()).rotations[0]?.stage).toBe("stored");
  });

  test("a stored rotation whose token still checks out is published", async () => {
    const run = await setup({ terminal: ["yes"], disk: await diskWith(record()) });
    run.vault.values.set(ITEM, NEW_VALUE);
    run.provider.tokens.set(NEW_ID, { ...OLD_TOKEN, id: NEW_ID, value: NEW_VALUE });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(0);
    expect((await run.rotations()).rotations[0]?.stage).toBe("published");
  });

  test("a rotation made in another account is left alone", async () => {
    const other = "c".repeat(32);
    const run = await setup({
      terminal: ["yes"],
      disk: await diskWith(record({ stage: "issued", account: other })),
    });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(1);
    expect(run.stderr.text).toContain(
      `made its token as cloudflare-account-token in account ${other}`,
    );
    expect(run.provider.log).toEqual([]);
    expect((await run.rotations()).rotations).toHaveLength(1);
  });

  test("another project's rotation of the same key ID is ignored", async () => {
    const elsewhere = record({
      item: {
        kind: "1password",
        account: "my.1password.com",
        vault: "App Secrets",
        item: "other token",
      },
    });
    const run = await setup({ terminal: ["no"], disk: await diskWith(elsewhere) });
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(2);
    expect(run.stderr.text).not.toContain("An unfinished rotation");
    expect(run.stderr.text).toContain("Plan:");
  });

  async function withRemoved(generation: string) {
    const disk = await diskWith(record({ stage: "published" }));
    const state = JSON.parse(disk.contents.get(STATE) ?? "{}");
    state.receipts = [
      await receiptFor(NEW_VALUE, "2026-11-10T13:00:00.000Z"),
      {
        ...(await receiptFor(OLD_VALUE)),
        generation,
        destinationId: "github-actions:acme/old-site:CLOUDFLARE_API_TOKEN",
      },
    ];
    disk.contents.set(STATE, JSON.stringify(state));
    return disk;
  }

  async function revokeRun(terminal: string[], disk: ReturnType<typeof memoryFiles>) {
    const run = await setup({ terminal, disk });
    run.provider.tokens.set(NEW_ID, { ...OLD_TOKEN, id: NEW_ID, value: NEW_VALUE });
    return run;
  }

  test("a destination that left the map with the old token is shown, and the typed yes revokes", async () => {
    const run = await revokeRun(["yes"], await withRemoved(OLD_GENERATION));
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain(
      `github-actions:acme/old-site:CLOUDFLARE_API_TOKEN left the map and its receipt has the old token (generation ${OLD_GENERATION}); revoking breaks it unless that secret is gone`,
    );
    expect(run.asked).toEqual([`Type yes to revoke the old token ${OLD_ID}: `]);
    expect(run.provider.tokens.has(OLD_ID)).toBe(false);
  });

  test("after removing that secret, a retry can still finish, and no only keeps the old token", async () => {
    const disk = await withRemoved(OLD_GENERATION);
    const refused = await revokeRun(["no"], disk);
    expect(await cli(["rotate", "site-deploy"], refused.deps)).toBe(2);
    expect(refused.provider.tokens.has(OLD_ID)).toBe(true);
    expect((await refused.rotations()).rotations[0]?.stage).toBe("published");
    const retry = await revokeRun(["yes"], disk);
    expect(await cli(["rotate", "site-deploy"], retry.deps)).toBe(0);
    expect((await retry.rotations()).rotations[0]?.stage).toBe("revoked");
  });

  test("a removed destination with another value, such as another project's key, isn't shown", async () => {
    const run = await revokeRun(["yes"], await withRemoved("0000000000000000"));
    expect(await cli(["rotate", "site-deploy"], run.deps)).toBe(0);
    expect(run.stderr.text).not.toContain("left the map");
    expect(run.provider.tokens.has(OLD_ID)).toBe(false);
  });

  test("follow-up commands keep --env dev: the plan, the rerun hint, status, and the revoke", async () => {
    const map = MAP.replaceAll("keys.site-deploy.prod", "keys.site-deploy.dev");
    const disk = memoryFiles({
      "/work/billing/keypin.toml": map,
      [REGISTRY]: registryWith("/work/billing"),
      [STATE]: JSON.stringify({
        version: 2,
        receipts: [{ ...(await receiptFor(OLD_VALUE)), environment: "dev" }],
        operations: [],
      }),
    });
    const first = await setup({ terminal: ["yes"], disk });
    expect(await cli(["rotate", "site-deploy", "--env", "dev"], first.deps)).toBe(0);
    expect(first.stderr.text).toContain(
      "then stop: the old token stays active until you run keypin rotate site-deploy --env dev again.",
    );
    expect(first.stderr.text).toContain(
      "Then run keypin rotate site-deploy --env dev again to revoke the old token.",
    );

    const status = await setup({ disk });
    await cli(["status"], status.deps);
    expect(status.stdout.text).toContain(
      `is at stage "published"; run keypin rotate site-deploy --env dev to continue`,
    );

    const hint = await setup({ disk });
    expect(await cli(["rotate", "site-deploy", "--env", "dev"], hint.deps)).toBe(2);
    expect(hint.stderr.text).toMatch(/&& \S+ \S+ rotate site-deploy --env dev\n/);

    const revoke = await setup({ terminal: ["yes"], disk });
    revoke.provider.tokens.set(NEW_ID, {
      ...OLD_TOKEN,
      id: NEW_ID,
      name: "cicd-keypin 2026-11-10",
      value: NEW_VALUE,
    });
    expect(await cli(["rotate", "site-deploy", "--env", "dev"], revoke.deps)).toBe(0);
    expect(revoke.asked).toEqual([`Type yes to revoke the old token ${OLD_ID}: `]);
    expect(revoke.stderr.text).toContain(
      `Rotated site-deploy (dev): ${NEW_ID} replaced ${OLD_ID}.`,
    );

    for (const text of [
      first.stderr.text,
      status.stdout.text,
      hint.stderr.text,
      revoke.stderr.text,
    ]) {
      expect(text).not.toMatch(/keypin rotate site-deploy(?! --env dev)/);
    }
  });
});
