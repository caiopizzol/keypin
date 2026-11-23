import { describe, expect, test } from "vite-plus/test";
import {
  dueKeys,
  emptyState,
  type Issued,
  type KeyRef,
  loadRotationFile,
  readSecretspec,
  type Progress,
  restoreIssued,
  restoreReceipts,
  removedBehind,
  rotationFile,
  rotationRecord,
  recordIssued,
  recordReceipt,
  type VaultMetadata,
  writeRotationFile,
} from "../src/index";
import { day } from "../src/testing/day";
import { fakeFiles, ISSUERS, KINDS, receipt, VAULT_KINDS } from "./fixtures";

const FILE = "/work/mailer/secretspec.toml";
const TODAY = day("2026-11-09");
const RESEND = `issuer = { kind = "resend", admin = "op://Private/resend admin key/credential", permission = "sending_access" }`;
const GITHUB = `publish = [{ to = "github-actions", repo = "acme/mailer" }]`;

const MAP = `
[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.dev]
DEV_ONLY = { description = "DEV_ONLY", ref = { item = "dev only", field = "credential" } }

[profiles.prod]
DUE_KEY = { description = "DUE_KEY", ref = { item = "due key", field = "credential" } }
TODAY_KEY = { description = "TODAY_KEY", ref = { item = "today key", field = "credential" } }
FRESH_KEY = { description = "FRESH_KEY", ref = { item = "fresh key", field = "credential" } }
BY_HAND = { description = "BY_HAND", ref = { item = "by hand", field = "credential" } }
NOWHERE = { description = "NOWHERE", ref = { item = "nowhere", field = "credential" } }
UNREADABLE = { description = "UNREADABLE", ref = { item = "unreadable", field = "credential" } }
UNDATED = { description = "UNDATED", ref = { item = "undated", field = "credential" } }
FOREVER = { description = "FOREVER", ref = { item = "forever", field = "credential" } }

[tool.keypin.dev.DEV_ONLY]
rotate_every = "90d"

[tool.keypin.prod.DUE_KEY]
rotate_every = "90d"
${GITHUB}
${RESEND}

[tool.keypin.prod.TODAY_KEY]
rotate_every = "90d"
${GITHUB}
${RESEND}

[tool.keypin.prod.FRESH_KEY]
rotate_every = "90d"
${GITHUB}
${RESEND}

[tool.keypin.prod.BY_HAND]
rotate_every = "90d"
${GITHUB}

[tool.keypin.prod.NOWHERE]
rotate_every = "90d"
${RESEND}

[tool.keypin.prod.UNREADABLE]
rotate_every = "90d"
${GITHUB}
${RESEND}

[tool.keypin.prod.UNDATED]
rotate_every = "90d"
${GITHUB}
${RESEND}

[tool.keypin.prod.FOREVER]
rotate_every = "never"
${GITHUB}
${RESEND}
`;

function parsed() {
  const result = readSecretspec(MAP, FILE, KINDS, ISSUERS, VAULT_KINDS);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.map;
}

const ROTATED: Record<string, string | null> = {
  "due key": "2026-08-01",
  "today key": "2026-08-11",
  "fresh key": "2026-11-01",
  nowhere: "2026-01-01",
  "by hand": "2026-01-01",
  undated: null,
  forever: "2020-01-01",
};

function metadata(ref: KeyRef): VaultMetadata | null {
  const item = typeof ref.item === "string" ? ref.item : "";
  if (!(item in ROTATED)) return null;
  const rotated = ROTATED[item] ?? null;
  return { rotated: rotated === null ? null : day(rotated) };
}

describe("rotate --due picks keys", () => {
  test("rotates the keys that are due and have an issuer, with or without a destination, and says why it skips the rest", () => {
    const choices = dueKeys({
      map: parsed(),
      environment: "prod",
      today: TODAY,
      metadata,
      progress: () => null,
    });
    expect(choices).toEqual([
      { keyId: "DUE_KEY", action: "rotate", why: "was due 2026-10-30" },
      { keyId: "TODAY_KEY", action: "rotate", why: "due today" },
      { keyId: "FRESH_KEY", action: "skip", why: "not due until 2027-01-30", date: "later" },
      { keyId: "BY_HAND", action: "skip", why: "no issuer, so keypin can't make a new key" },
      { keyId: "NOWHERE", action: "rotate", why: "was due 2026-04-01" },
      {
        keyId: "UNREADABLE",
        action: "skip",
        why: "the vault's rotated date couldn't be read",
        date: "missing",
      },
      { keyId: "UNDATED", action: "skip", why: "no rotated date in the vault", date: "missing" },
      { keyId: "FOREVER", action: "skip", why: "never rotates" },
    ]);
  });

  test("finishes a rotation that stopped, and leaves one that waits for approval, whatever the date", () => {
    const progress = (keyId: string): Progress =>
      keyId === "FRESH_KEY"
        ? { kind: "unfinished", since: "2026-11-01", revokes: true }
        : keyId === "DUE_KEY"
          ? { kind: "waiting", since: "2026-11-02", revokes: true }
          : null;
    const choices = dueKeys({
      map: parsed(),
      environment: "prod",
      today: TODAY,
      metadata,
      progress,
    });
    expect(choices.slice(0, 3)).toEqual([
      { keyId: "DUE_KEY", action: "waiting", why: "rotated 2026-11-02, the old key waits" },
      { keyId: "TODAY_KEY", action: "rotate", why: "due today" },
      { keyId: "FRESH_KEY", action: "finish", why: "finishing the rotation from 2026-11-01" },
    ]);
  });
});

const ISSUED: Issued = {
  keyId: "DUE_KEY",
  environment: "prod",
  mapFile: FILE,
  issuer: "resend",
  id: "re-new-1",
  generation: "aaaaaaaaaaaaaaaa",
  at: "2026-11-09T12:00:00.000Z",
  old: { id: "key-0", generation: "bbbbbbbbbbbbbbbb", revoked: false },
};

const DESTINATION = "github-actions:acme/mailer:DUE_KEY";
const IDS = { vault: "vault-id-1", item: "item-id-1" };

function published() {
  const map = parsed();
  const ref = map.keys.find((key) => key.name === "DUE_KEY")?.environments.prod?.ref ?? null;
  let state = recordIssued(emptyState(), ISSUED);
  state = recordReceipt(
    state,
    receipt(DESTINATION, ISSUED.generation, {
      keyId: "DUE_KEY",
      mapFile: FILE,
      source: ref,
      sourceIds: IDS,
      account: { pinned: "acme", publisher: "me@example.com", destinationAccount: "acme" },
      at: "2026-11-09T12:00:01.000Z",
    }),
    KINDS,
  );
  return { map, state };
}

describe(".keypin/rotation.json", () => {
  test("holds key names, environments, provider key IDs, generations, dates and hashes, never a value or a reference", async () => {
    const { map, state } = published();
    const file = await rotationFile(state, map, KINDS, null);
    const text = JSON.stringify(file);
    expect(file.issued).toEqual([
      {
        key: "DUE_KEY",
        environment: "prod",
        issuer: "resend",
        id: "re-new-1",
        generation: "aaaaaaaaaaaaaaaa",
        at: "2026-11-09T12:00:00.000Z",
        old: { id: "key-0", generation: "bbbbbbbbbbbbbbbb", revoked: false },
      },
    ]);
    const [write, ...more] = file.published;
    expect(more).toEqual([]);
    expect(write?.approved).toMatch(/^[0-9a-f]{16}$/);
    expect({ ...write, approved: "hash" }).toEqual({
      key: "DUE_KEY",
      environment: "prod",
      destination: DESTINATION,
      account: "acme",
      generation: "aaaaaaaaaaaaaaaa",
      at: "2026-11-09T12:00:01.000Z",
      approved: "hash",
    });
    expect(text).not.toMatch(
      /op:|1password|Private|due key|my\.1password|vault-id|item-id|me@example|\/work|mapFile|evidence/,
    );
    const keys = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap(keys)
        : value !== null && typeof value === "object"
          ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)])
          : [];
    expect([...new Set(keys(file))].toSorted()).toEqual([
      "account",
      "approved",
      "at",
      "destination",
      "environment",
      "generation",
      "id",
      "issued",
      "issuer",
      "key",
      "old",
      "published",
      "revoked",
      "version",
    ]);
  });

  test("a fresh machine gets the rotation back from the file alone", async () => {
    const { map, state } = published();
    const file = await rotationFile(state, map, KINDS, null);
    const owner = { keyId: "DUE_KEY", environment: "prod", mapFile: FILE };
    const fresh = restoreIssued(emptyState(), file, map);
    expect(fresh.issued).toEqual([ISSUED]);
    const back = await restoreReceipts({
      state: fresh,
      file,
      map,
      kinds: KINDS,
      owner,
      ids: async () => IDS,
    });
    expect(back.receipts).toMatchObject([
      { destinationId: DESTINATION, generation: ISSUED.generation, sourceIds: IDS },
    ]);
  });

  test("a write approved for another vault item doesn't count on a fresh machine", async () => {
    const { map, state } = published();
    const file = await rotationFile(state, map, KINDS, null);
    const back = await restoreReceipts({
      state: restoreIssued(emptyState(), file, map),
      file,
      map,
      kinds: KINDS,
      owner: { keyId: "DUE_KEY", environment: "prod", mapFile: FILE },
      ids: async () => ({ vault: "vault-id-1", item: "another-item" }),
    });
    expect(back.receipts).toEqual([]);
  });

  test("a revoke recorded on another machine isn't undone by an older local state", async () => {
    const { map, state } = published();
    const revoked = recordIssued(state, { ...ISSUED, old: { ...ISSUED.old, revoked: true } });
    const file = await rotationFile(revoked, map, KINDS, null);
    expect(file.issued[0]?.old.revoked).toBe(true);
    const merged = await rotationFile(state, map, KINDS, file);
    expect(merged.issued[0]?.old.revoked).toBe(true);
    expect(restoreIssued(state, file, map).issued[0]?.old.revoked).toBe(true);
  });

  test("says per key where the new key went and whether the old key waits", async () => {
    const { map, state } = published();
    const file = await rotationFile(state, map, KINDS, null);
    expect(rotationRecord(file, map, KINDS, "DUE_KEY", "prod")).toEqual({
      at: "2026-11-09T12:00:00.000Z",
      published: ["github-actions:acme/mailer"],
      unpublished: [],
      old: "waiting for approval",
    });
    const unpublished = { ...file, published: [] };
    expect(rotationRecord(unpublished, map, KINDS, "DUE_KEY", "prod")?.old).toBe("still in use");
    expect(rotationRecord(file, map, KINDS, "TODAY_KEY", "prod")).toBeNull();
  });

  test("round-trips, refuses a malformed file, and writes nothing while there's nothing to record", async () => {
    const { map, state } = published();
    const disk = fakeFiles();
    const path = "/work/mailer/.keypin/rotation.json";
    expect(
      await writeRotationFile(disk.files, path, await rotationFile(emptyState(), map, KINDS, null)),
    ).toBe("unchanged");
    expect(disk.contents.has(path)).toBe(false);
    const file = await rotationFile(state, map, KINDS, null);
    expect(await writeRotationFile(disk.files, path, file)).toBe("written");
    expect(await writeRotationFile(disk.files, path, file)).toBe("unchanged");
    expect(await loadRotationFile(disk.files, path)).toEqual(file);
    disk.contents.set(path, JSON.stringify({ version: 1, issued: [{ key: "A" }], published: [] }));
    await expect(loadRotationFile(disk.files, path)).rejects.toThrow(
      `${path}: the rotation file's "issued" must be a list of issued keys`,
    );
  });
});

describe("destinations taken out of the map", () => {
  const OLD_ACCOUNT = "a".repeat(32);
  const NEW_ACCOUNT = "b".repeat(32);
  const WEB = "cloudflare-worker:web:DUE_KEY";
  const worker = (account: string) =>
    `
[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
DUE_KEY = { description = "DUE_KEY", ref = { item = "due key", field = "credential" } }

[tool.keypin.prod.DUE_KEY]
rotate_every = "90d"
publish = [{ to = "cloudflare-worker", account = "${account}", worker = "web" }]
${RESEND}
`;

  test("a Worker of the same name in another account counts as taken out while it may hold the old key", async () => {
    const result = readSecretspec(worker(NEW_ACCOUNT), FILE, KINDS, ISSUERS, VAULT_KINDS);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const map = result.map;
    const ref = map.keys.find((key) => key.name === "DUE_KEY")?.environments.prod?.ref ?? null;
    const sent = (account: string, generation: string, at: string) =>
      receipt(WEB, generation, {
        keyId: "DUE_KEY",
        mapFile: FILE,
        source: ref,
        sourceIds: IDS,
        account: { pinned: account, publisher: "me@example.com", destinationAccount: account },
        at,
      });
    let state = recordIssued(emptyState(), ISSUED);
    state = recordReceipt(
      state,
      sent(OLD_ACCOUNT, ISSUED.old.generation, "2026-08-01T00:00:00.000Z"),
      KINDS,
    );
    state = recordReceipt(state, sent(NEW_ACCOUNT, ISSUED.generation, ISSUED.at), KINDS);

    const file = await rotationFile(state, map, KINDS, null);
    expect(file.published.map((p) => [p.destination, p.account, p.generation])).toEqual([
      [WEB, OLD_ACCOUNT, ISSUED.old.generation],
      [WEB, NEW_ACCOUNT, ISSUED.generation],
    ]);
    const owner = { keyId: "DUE_KEY", environment: "prod", mapFile: FILE };
    expect(removedBehind(file, map, KINDS, owner, ISSUED.generation).map((p) => p.account)).toEqual(
      [OLD_ACCOUNT],
    );

    const revoked = recordIssued(state, { ...ISSUED, old: { ...ISSUED.old, revoked: true } });
    const after = await rotationFile(revoked, map, KINDS, file);
    expect(
      after.published.map((p) => p.account),
      "dropped once its key is revoked",
    ).toEqual([NEW_ACCOUNT]);
  });

  test("a write to the same Worker name in the account the map no longer names doesn't count as published", async () => {
    const before = readSecretspec(worker(OLD_ACCOUNT), FILE, KINDS, ISSUERS, VAULT_KINDS);
    const after = readSecretspec(worker(NEW_ACCOUNT), FILE, KINDS, ISSUERS, VAULT_KINDS);
    if (!before.ok || !after.ok) throw new Error("map");
    const ref =
      before.map.keys.find((key) => key.name === "DUE_KEY")?.environments.prod?.ref ?? null;
    const state = recordReceipt(
      recordIssued(emptyState(), ISSUED),
      receipt(WEB, ISSUED.generation, {
        keyId: "DUE_KEY",
        mapFile: FILE,
        source: ref,
        sourceIds: IDS,
        account: {
          pinned: OLD_ACCOUNT,
          publisher: "me@example.com",
          destinationAccount: OLD_ACCOUNT,
        },
        at: ISSUED.at,
      }),
      KINDS,
    );
    const file = await rotationFile(state, before.map, KINDS, null);
    expect(rotationRecord(file, before.map, KINDS, "DUE_KEY", "prod")?.old).toBe(
      "waiting for approval",
    );
    expect(rotationRecord(file, after.map, KINDS, "DUE_KEY", "prod")).toMatchObject({
      published: [],
      unpublished: ["cloudflare-worker:web"],
      old: "still in use",
    });
  });

  test("a case-only edit to a GitHub repository name keeps the saved write, as the planner does", async () => {
    const { map, state } = published();
    const file = await rotationFile(state, map, KINDS, null);
    const renamed = readSecretspec(
      MAP.replaceAll("acme/mailer", "acme/Mailer"),
      FILE,
      KINDS,
      ISSUERS,
      VAULT_KINDS,
    );
    if (!renamed.ok) throw new Error(renamed.errors.join("\n"));
    expect(rotationRecord(file, renamed.map, KINDS, "DUE_KEY", "prod")).toMatchObject({
      published: ["github-actions:acme/Mailer"],
      unpublished: [],
      old: "waiting for approval",
    });
    const owner = { keyId: "DUE_KEY", environment: "prod", mapFile: FILE };
    const ids = async () => IDS;
    const restored = await restoreReceipts({
      state: emptyState(),
      file,
      map: renamed.map,
      kinds: KINDS,
      owner,
      ids,
    });
    expect(
      restored.receipts.map((r) => r.generation),
      "the receipt still validates",
    ).toEqual([ISSUED.generation]);
  });

  test("a case-only edit to a GitHub owner is a changed account, as the planner treats it, so --due publishes again", async () => {
    const { map, state } = published();
    const file = await rotationFile(state, map, KINDS, null);
    const edited = readSecretspec(
      MAP.replaceAll("acme/mailer", "Acme/mailer"),
      FILE,
      KINDS,
      ISSUERS,
      VAULT_KINDS,
    );
    if (!edited.ok) throw new Error(edited.errors.join("\n"));
    expect(rotationRecord(file, map, KINDS, "DUE_KEY", "prod")?.unpublished).toEqual([]);
    expect(rotationRecord(file, edited.map, KINDS, "DUE_KEY", "prod")).toMatchObject({
      published: [],
      unpublished: ["github-actions:Acme/mailer"],
    });
  });
});
