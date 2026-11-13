import { expect, test } from "vite-plus/test";
import { approvalsFor, type ItemIds, type KeyRef, planPublish } from "../src/index";
import { GITHUB, KEY, KEY_MAP, receipt, WORKER } from "./fixtures";

const anyText: unknown = expect.any(String);

const NEW = "aaaaaaaaaaaaaaaa";
const OLD = "bbbbbbbbbbbbbbbb";

const summary = (plan: ReturnType<typeof planPublish>) =>
  plan.steps.map(({ action, destinationId, reason, approval }) => ({
    action,
    destinationId,
    reason,
    approval,
  }));

test("first publish writes every destination, and each needs approval", () => {
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [],
    generation: NEW,
    ids: null,
  });
  expect(summary(plan)).toEqual([
    {
      action: "write",
      destinationId: WORKER,
      reason: "no receipt",
      approval: `first write to ${WORKER} (account 11111111111111111111111111111111)`,
    },
    {
      action: "write",
      destinationId: GITHUB,
      reason: "no receipt",
      approval: `first write to ${GITHUB} (account acme)`,
    },
  ]);
  expect(plan.needsApproval).toBe(true);
  expect(plan.removed).toEqual([]);
});

test("resuming after one destination skips it and writes the rest", () => {
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [receipt(WORKER, NEW)],
    generation: NEW,
    ids: null,
  });
  expect(summary(plan)).toEqual([
    {
      action: "skip",
      destinationId: WORKER,
      reason: "receipt already has this generation",
      approval: null,
    },
    {
      action: "write",
      destinationId: GITHUB,
      reason: "new destination",
      approval: `first write to ${GITHUB} (account acme)`,
    },
  ]);
});

test("the same generation everywhere leaves nothing to do", () => {
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [receipt(WORKER, NEW), receipt(GITHUB, NEW)],
    generation: NEW,
    ids: null,
  });
  expect(plan.steps.every((s) => s.action === "skip")).toBe(true);
  expect(plan.needsApproval).toBe(false);
});

test("a new generation rewrites known destinations without approval", () => {
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [receipt(WORKER, OLD), receipt(GITHUB, OLD)],
    generation: NEW,
    ids: null,
  });
  expect(summary(plan).map((s) => [s.action, s.reason, s.approval])).toEqual([
    ["write", "different generation", null],
    ["write", "different generation", null],
  ]);
  expect(plan.needsApproval).toBe(false);
});

test("a destination whose account changed needs approval, even with the same generation", () => {
  const moved = receipt(WORKER, NEW, {
    account: {
      pinned: "33333333333333333333333333333333",
      publisher: "acme",
      destinationAccount: "33333333333333333333333333333333",
    },
  });
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [moved, receipt(GITHUB, NEW)],
    generation: NEW,
    ids: null,
  });
  expect(summary(plan)[0]).toEqual({
    action: "write",
    destinationId: WORKER,
    reason: "account changed",
    approval: `${WORKER} account changed from 33333333333333333333333333333333 to 11111111111111111111111111111111`,
  });
  expect(plan.needsApproval).toBe(true);
});

test("a destination removed from the map is reported, not deleted", () => {
  const gone = receipt("github-actions:acme/old-billing:STRIPE_API_KEY", OLD, {
    at: "2026-10-23T00:46:55Z",
    account: { pinned: "acme", publisher: "acme", destinationAccount: "acme" },
  });
  const receipts = [receipt(WORKER, NEW), receipt(GITHUB, NEW), gone];
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts,
    generation: NEW,
    ids: null,
  });
  expect(plan.removed).toEqual([
    {
      destinationId: "github-actions:acme/old-billing:STRIPE_API_KEY",
      lastReceipt: {
        generation: OLD,
        at: "2026-10-23T00:46:55Z",
        destinationAccount: "acme",
      },
    },
  ]);
  expect(plan.steps.map((s) => s.destinationId)).toEqual([WORKER, GITHUB]);
});

test("another project's destinations for the same variable and environment aren't removed from this one", () => {
  const web = receipt("github-actions:acme/web:STRIPE_API_KEY", OLD, {
    mapFile: "/work/web/keypin.toml",
  });
  const receipts = [receipt(WORKER, NEW), receipt(GITHUB, NEW), web];
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts,
    generation: NEW,
    ids: null,
  });
  expect(plan.removed).toEqual([]);
});

test("a receipt with no project, from state version 2 or older, isn't this key's own, but still matches its destination by item", () => {
  const old = (id: string) => receipt(id, NEW, { mapFile: null });
  const gone = old("github-actions:acme/old-billing:STRIPE_API_KEY");
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [old(WORKER), old(GITHUB), gone],
    generation: NEW,
    ids: null,
  });
  expect(plan.removed).toEqual([]);
  expect(summary(plan).map((s) => [s.action, s.reason])).toEqual([
    ["skip", "receipt already has this generation"],
    ["skip", "receipt already has this generation"],
  ]);
});

test("the newest receipt per destination decides, whichever key wrote it", () => {
  const receipts = [
    receipt(WORKER, NEW, { at: "2026-11-09T10:00:00Z" }),
    receipt(WORKER, OLD, { at: "2026-11-09T12:00:00Z" }),
    receipt(GITHUB, OLD, { keyId: "another-key", at: "2026-11-09T10:00:00Z" }),
    receipt(GITHUB, NEW, { at: "2026-11-09T12:00:00Z" }),
  ];
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts,
    generation: NEW,
    ids: null,
  });
  expect(summary(plan).map((s) => s.reason)).toEqual([
    "different generation",
    "receipt already has this generation",
  ]);
});

const OTHER_ITEM = {
  kind: "1password",
  account: "my.1password.com",
  vault: "Private",
  item: "cloudflare admin token",
  section: null,
  field: "password",
} as const;

test("a destination last published from another item needs approval, even with the same generation", () => {
  for (const generation of [NEW, OLD]) {
    const plan = planPublish({
      key: KEY,
      environment: "prod",
      mapFile: KEY_MAP,
      receipts: [receipt(WORKER, NEW, { source: OTHER_ITEM }), receipt(GITHUB, NEW)],
      generation,
      ids: null,
    });
    expect(summary(plan)[0]).toEqual({
      action: "write",
      destinationId: WORKER,
      reason: "item changed",
      approval: `${WORKER} was last published from op://Private/cloudflare admin token/password (1Password account my.1password.com), and now from op://Private/billing stripe api key/password (1Password account my.1password.com)`,
    });
    expect(plan.needsApproval).toBe(true);
  }
});

test("a receipt with item IDs compares the item read now by ID, and still compares the field and account", () => {
  const IDS = { vault: "vault-1", item: "item-1" };
  const reasons = (source: KeyRef | undefined, ids: ItemIds | null) =>
    summary(
      planPublish({
        key: KEY,
        environment: "prod",
        mapFile: KEY_MAP,
        receipts: [receipt(WORKER, NEW, { sourceIds: IDS, ...(source ? { source } : {}) })],
        generation: NEW,
        ids,
      }),
    )[0]?.reason;

  expect(reasons(undefined, IDS)).toBe("receipt already has this generation");
  expect(reasons(OTHER_ITEM, IDS)).toBe("receipt already has this generation");
  expect(reasons(undefined, { ...IDS, item: "item-2" })).toBe("item changed");
  expect(reasons(undefined, { ...IDS, vault: "vault-2" })).toBe("item changed");
  expect(reasons({ ...OTHER_ITEM, item: "billing stripe api key", field: "credential" }, IDS)).toBe(
    "item changed",
  );
  expect(reasons({ ...OTHER_ITEM, account: "other.1password.com" }, IDS)).toBe("item changed");
  expect(reasons(undefined, null)).toBe("receipt already has this generation");
  expect(reasons(OTHER_ITEM, null)).toBe("receipt already has this generation");
});

test("a receipt that another project or key left, from another item, needs approval", () => {
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [
      receipt(WORKER, OLD, { keyId: "deploy", source: OTHER_ITEM }),
      receipt(GITHUB, OLD, { environment: "dev", source: OTHER_ITEM }),
    ],
    generation: NEW,
    ids: null,
  });
  expect(summary(plan).map((s) => s.reason)).toEqual(["item changed", "item changed"]);
});

test("a receipt that doesn't record its item, from state version 1, needs approval once", () => {
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [receipt(WORKER, NEW, { source: null }), receipt(GITHUB, NEW)],
    generation: NEW,
    ids: null,
  });
  const approval: unknown = expect.stringContaining("an item its receipt doesn't record");
  expect(summary(plan)[0]).toMatchObject({ action: "write", reason: "item changed", approval });
  expect(summary(plan)[1]?.action).toBe("skip");
});

test("a receipt for the same GitHub secret spelled in another case is the same destination", () => {
  const aliased = receipt("github-actions:Acme/Billing:stripe_api_key", NEW, {
    keyId: "other",
    source: OTHER_ITEM,
    account: { pinned: "acme", publisher: "acme", destinationAccount: "acme" },
  });
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [receipt(WORKER, NEW), receipt(GITHUB, OLD, { at: "2026-11-09T10:00:00Z" }), aliased],
    generation: NEW,
    ids: null,
  });
  expect(summary(plan)[1]).toMatchObject({ action: "write", reason: "item changed" });
  expect(plan.removed).toEqual([]);
});

test("a GitHub environment secret is another destination from the repo secret", () => {
  const prod = KEY.environments.prod;
  if (!prod) throw new Error("no prod entry");
  const environment = "github-actions:acme/billing/environments/Production:STRIPE_API_KEY";
  const key = {
    ...KEY,
    environments: {
      prod: {
        ...prod,
        publish: [
          ...prod.publish,
          {
            to: "github-actions" as const,
            repo: "acme/billing",
            account: "acme",
            environment: "Production",
          },
        ],
      },
    },
  };
  const input = { key, environment: "prod", mapFile: KEY_MAP, generation: NEW, ids: null };
  const first = planPublish({ ...input, receipts: [receipt(WORKER, NEW), receipt(GITHUB, NEW)] });
  expect(summary(first)[2]).toEqual({
    action: "write",
    destinationId: environment,
    reason: "new destination",
    approval: `first write to ${environment} (account acme)`,
  });

  const done = receipt(environment, NEW, {
    account: { pinned: "acme", publisher: "acme", destinationAccount: "acme" },
  });
  const after = planPublish({
    ...input,
    receipts: [receipt(WORKER, NEW), receipt(GITHUB, NEW), done],
  });
  expect(summary(after).map((s) => s.action)).toEqual(["skip", "skip", "skip"]);

  const repoOnly = planPublish({ ...input, key: KEY, receipts: [receipt(GITHUB, NEW), done] });
  expect(repoOnly.removed.map((r) => r.destinationId)).toEqual([environment]);
});

test("a Worker receipt from another Cloudflare account is another secret", () => {
  const elsewhere = receipt(WORKER, NEW, {
    keyId: "other",
    source: OTHER_ITEM,
    account: { pinned: "ffff", publisher: "acme", destinationAccount: "ffff" },
  });
  const plan = planPublish({
    key: KEY,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [receipt(WORKER, NEW), receipt(GITHUB, NEW), elsewhere],
    generation: NEW,
    ids: null,
  });
  expect(summary(plan).map((s) => s.action)).toEqual(["skip", "skip"]);
});

test("approvals are known from the receipts alone, before any value is read", () => {
  expect(approvalsFor({ key: KEY, environment: "prod", mapFile: KEY_MAP, receipts: [] })).toEqual([
    { destinationId: WORKER, reason: "no receipt", approval: anyText },
    { destinationId: GITHUB, reason: "no receipt", approval: anyText },
  ]);
  const receipts = [receipt(WORKER, OLD), receipt(GITHUB, OLD, { source: OTHER_ITEM })];
  expect(approvalsFor({ key: KEY, environment: "prod", mapFile: KEY_MAP, receipts })).toEqual([
    { destinationId: GITHUB, reason: "item changed", approval: anyText },
  ]);
});

test("an environment the key doesn't have is an error", () => {
  expect(() =>
    planPublish({
      key: KEY,
      environment: "dev",
      mapFile: KEY_MAP,
      receipts: [],
      generation: NEW,
      ids: null,
    }),
  ).toThrow('key "STRIPE_API_KEY" has no dev entry in the map');
});

test("a renamed variable is a new key: every write needs approval, and nothing is deleted", () => {
  const renamed = { ...KEY, name: "STRIPE_KEY" };
  const plan = planPublish({
    key: renamed,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [receipt(WORKER, NEW), receipt(GITHUB, NEW)],
    generation: NEW,
    ids: null,
  });
  expect(summary(plan).map((s) => [s.action, s.destinationId, s.reason])).toEqual([
    ["write", "cloudflare-worker:billing-worker:STRIPE_KEY", "no receipt"],
    ["write", "github-actions:acme/billing:STRIPE_KEY", "no receipt"],
  ]);
  expect(plan.needsApproval).toBe(true);
  expect(plan.removed).toEqual([]);
});

test("an organization repo published by another login compares the pin, not the owner", () => {
  const key = {
    ...KEY,
    environments: {
      prod: {
        ref: KEY.environments.prod?.ref ?? {
          kind: "1password" as const,
          account: "a",
          vault: "v",
          item: "i",
          section: null,
          field: "password",
        },
        publish: [{ to: "github-actions" as const, repo: "acme/billing", account: "alice" }],
      },
    },
  };
  const plan = planPublish({
    key,
    environment: "prod",
    mapFile: KEY_MAP,
    receipts: [
      receipt("github-actions:acme/billing:STRIPE_API_KEY", NEW, {
        account: { pinned: "alice", publisher: "alice", destinationAccount: "acme" },
      }),
    ],
    generation: NEW,
    ids: null,
  });
  expect(summary(plan).map((s) => [s.action, s.reason])).toEqual([
    ["skip", "receipt already has this generation"],
  ]);
});
