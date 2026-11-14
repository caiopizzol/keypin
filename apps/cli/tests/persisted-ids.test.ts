import { assert, describe, expect, test } from "vite-plus/test";
import { generationOf, isRecord, loadState, type Receipt, Secret } from "@keypin/core";
import { cli } from "../src/cli";
import {
  fakeDeps,
  type FakeDestinationOptions,
  fakeDestinations,
  fakeVault,
  memoryFiles,
  parseJson,
  REGISTRY,
  registryWith,
  SENTINEL,
  STATE,
} from "./fakes";

const ACCOUNT = "11111111111111111111111111111111";
const OTHER_ACCOUNT = "22222222222222222222222222222222";
const MAP_FILE = "/work/billing/keypin.toml";
const REF = "op://Private/billing stripe api key/password";

const MAP = `
[1password]
account = "my.1password.com"

[keys.Stripe_Key]
rotate_every = "365d"
prod = { from = "${REF}", publish = [
  { to = "cloudflare-worker", account = "${ACCOUNT}", worker = "billing-worker" },
  { to = "github-actions", repo = "Acme/Billing" },
  { to = "github-actions", repo = "Acme/Billing", environment = "Production" },
] }
`;

const DESTINATION_IDS = [
  "cloudflare-worker:billing-worker:Stripe_Key",
  "github-actions:Acme/Billing:Stripe_Key",
  "github-actions:Acme/Billing/environments/Production:Stripe_Key",
];

const SECRET_KEYS = [
  `cloudflare-worker:${ACCOUNT}:billing-worker:Stripe_Key`,
  "github-actions:acme/billing:STRIPE_KEY",
  "github-actions:acme/billing/environments/production:STRIPE_KEY",
];

const TARGET_IDS = [
  `cloudflare-worker:${ACCOUNT}/billing-worker`,
  "github-actions:acme/billing",
  "github-actions:acme/billing/environments/production",
];

function setup(options: FakeDestinationOptions & { state?: string } = {}) {
  const disk = memoryFiles({
    [MAP_FILE]: MAP,
    [REGISTRY]: registryWith("/work/billing"),
    ...(options.state === undefined ? {} : { [STATE]: options.state }),
  });
  const destinations = fakeDestinations(options);
  const fake = fakeDeps({
    disk,
    backend: fakeVault({ values: { "billing stripe api key": SENTINEL } }).vault,
    deps: {
      destination: destinations.build,
      wranglerLoginFile: async () => "/home/me/.wrangler/config/default.toml",
      isTerminal: true,
      ask: async () => "yes",
    },
  });
  return { ...fake, log: destinations.log, state: () => loadState(disk.files, STATE) };
}

function checked(text: string) {
  const data = parseJson(text);
  assert(isRecord(data) && Array.isArray(data.keys) && Array.isArray(data.problems));
  const destinations = data.keys.flatMap((key: unknown) =>
    isRecord(key) && Array.isArray(key.destinations)
      ? key.destinations.map((d: unknown) => (isRecord(d) ? d.destination : null))
      : [],
  );
  return { destinations, problems: data.problems };
}

describe("the destination IDs keypin saves in state.json never change", () => {
  test("a receipt's destination ID keeps the map's case", async () => {
    const run = setup();
    expect(await cli(["publish", "Stripe_Key"], run.deps)).toBe(0);
    expect((await run.state()).receipts.map((r) => r.destinationId)).toEqual(DESTINATION_IDS);
  });

  test("a destination secret folds GitHub's case and scopes a Worker to its account", async () => {
    const run = setup();
    await cli(["check", "--json"], run.deps);
    expect(checked(run.stdout.text).destinations).toEqual(SECRET_KEYS);
  });

  test("a failed account check names the place without the secret", async () => {
    const run = setup({
      badAccount: [
        "cloudflare-worker:billing-worker",
        "github-actions:Acme/Billing",
        "github-actions:Acme/Billing/environments/Production",
      ],
    });
    await cli(["check", "--json"], run.deps);
    const { problems } = checked(run.stdout.text);
    expect(problems.map((p) => String(p).split(": ")[0])).toEqual(TARGET_IDS);
  });

  test("a GitHub secret in another case is the same secret; a Worker in another account isn't", async () => {
    const old = (destinationId: string, pinned: string): Receipt => ({
      keyId: "STRIPE_KEY",
      environment: "prod",
      mapFile: "/work/web/keypin.toml",
      source: {
        kind: "1password",
        account: "my.1password.com",
        vault: "Private",
        item: "billing stripe api key",
        section: null,
        field: "password",
      },
      sourceIds: null,
      destinationId,
      generation: "0000000000000000",
      account: { pinned, publisher: "acme", destinationAccount: pinned },
      at: "2026-11-01T00:00:00Z",
      evidence: {},
    });
    const before = [
      old("github-actions:acme/billing:STRIPE_KEY", "Acme"),
      old("cloudflare-worker:billing-worker:Stripe_Key", OTHER_ACCOUNT),
    ];
    const state = JSON.stringify({ version: 5, receipts: before, operations: [], issued: [] });

    const run = setup({ state });
    expect(await cli(["publish", "Stripe_Key"], run.deps)).toBe(0);
    expect(run.stderr.text).toMatch(/~ GitHub +Acme\/Billing +new value\n/);
    expect(run.stderr.text).toMatch(/\+ Cloudflare +billing-worker +first write/);

    const generation = await generationOf(new Secret(SENTINEL));
    const after = (await run.state()).receipts;
    expect(after.map((r) => [r.destinationId, r.generation])).toEqual([
      ["cloudflare-worker:billing-worker:Stripe_Key", "0000000000000000"],
      ...DESTINATION_IDS.map((id) => [id, generation]),
    ]);
  });
});
