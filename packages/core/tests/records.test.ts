import { assert, describe, expect, test } from "vite-plus/test";
import {
  emptyState,
  finishOperation,
  type Issued,
  issuedFor,
  loadRegistry,
  loadState,
  nextRotation,
  receiptsFor,
  recordIssued,
  recordReceipt,
  register,
  saveState,
  startOperation,
  unfinishedOperations,
  unregister,
  type Receipt,
} from "../src/index";
import { fakeFiles, GITHUB, KEY, KEY_MAP, KINDS, receipt, VAULT_KINDS, WORKER } from "./fixtures";

const STATE = "/state/keypin/state.json";
const REGISTRY = "/config/keypin/registry.json";
const OWNER = { keyId: KEY.name, environment: "prod", mapFile: KEY_MAP };
const WEB_MAP = "/work/web/keypin.toml";

describe("state", () => {
  test("a missing file is an empty state", async () => {
    expect(await loadState(fakeFiles().files, STATE, VAULT_KINDS)).toEqual(emptyState());
  });

  test("saving writes a temporary file, then renames it over the state file", async () => {
    const fake = fakeFiles();
    const state = recordReceipt(emptyState(), receipt(WORKER, "aaaaaaaaaaaaaaaa"), KINDS);
    await saveState(fake.files, STATE, state);
    expect(fake.log).toHaveLength(2);
    const [write, rename] = fake.log;
    assert(write);
    const temporary = write.replace(/^write /, "");
    expect(temporary).toMatch(/^\/state\/keypin\/state\.json\..+\.tmp$/);
    expect(rename).toBe(`rename ${temporary} -> ${STATE}`);
    expect([...fake.contents.keys()]).toEqual([STATE]);
    expect(await loadState(fake.files, STATE, VAULT_KINDS)).toEqual(state);
  });

  test("a crash before the rename leaves the old state whole", async () => {
    const before = recordReceipt(emptyState(), receipt(WORKER, "aaaaaaaaaaaaaaaa"), KINDS);
    const fake = fakeFiles({ [STATE]: JSON.stringify(before) });
    fake.fail("rename");
    const after = recordReceipt(before, receipt(GITHUB, "aaaaaaaaaaaaaaaa"), KINDS);
    await expect(saveState(fake.files, STATE, after)).rejects.toThrow("crashed before rename");
    expect(await loadState(fake.files, STATE, VAULT_KINDS)).toEqual(before);
    expect([...fake.contents.keys()]).toEqual([STATE]);
  });

  test("a cleanup that also fails reports the original error", async () => {
    const fake = fakeFiles();
    fake.fail("rename");
    fake.files.remove = async () => {
      throw new Error("EACCES: can't remove");
    };
    await expect(saveState(fake.files, STATE, emptyState())).rejects.toThrow(
      "crashed before rename",
    );
  });

  test("a source saved before references named a field reads as the password field", async () => {
    const saved = receipt(WORKER, "aaaaaaaaaaaaaaaa");
    assert(saved.source?.kind === "1password");
    const { section: _section, field: _field, ...before } = saved.source;
    const fake = fakeFiles({
      [STATE]: JSON.stringify({
        version: 3,
        receipts: [{ ...saved, source: before }],
        operations: [],
      }),
    });
    expect((await loadState(fake.files, STATE, VAULT_KINDS)).receipts[0]?.source).toEqual(
      saved.source,
    );
  });

  test("a receipt with an Infisical source saves and loads whole", async () => {
    const source = {
      kind: "infisical" as const,
      url: "https://app.infisical.com",
      organization: "acme",
      project: "billing",
      environment: "prod",
      path: "/",
      name: "STRIPE_KEY",
    };
    const fake = fakeFiles();
    const state = recordReceipt(
      emptyState(),
      receipt(WORKER, "aaaaaaaaaaaaaaaa", { source }),
      KINDS,
    );
    await saveState(fake.files, STATE, state);
    expect((await loadState(fake.files, STATE, VAULT_KINDS)).receipts[0]?.source).toEqual(source);
  });

  test("another schema version gives a clear error", async () => {
    const fake = fakeFiles({
      [STATE]: JSON.stringify({ version: 6, receipts: [], operations: [] }),
    });
    await expect(loadState(fake.files, STATE, VAULT_KINDS)).rejects.toThrow(
      `${STATE}: the state file has schema version 6, and this keypin reads version 1 or 2 or 3 or 4 or 5`,
    );
  });

  test("a version 1 file loads, with receipts that record neither item nor project, and saves as version 5", async () => {
    const old = withoutSource(receipt(WORKER, "aaaaaaaaaaaaaaaa"));
    const fake = fakeFiles({
      [STATE]: JSON.stringify({ version: 1, receipts: [old], operations: [] }),
    });
    const state = await loadState(fake.files, STATE, VAULT_KINDS);
    expect(state).toEqual({
      version: 5,
      receipts: [{ ...old, mapFile: null, source: null, sourceIds: null }],
      operations: [],
      issued: [],
    });
    await saveState(fake.files, STATE, state);
    expect(await loadState(fake.files, STATE, VAULT_KINDS)).toEqual(state);
    expect(fake.contents.get(STATE)).toContain('"version": 5');
  });

  test("a version 2 file loads with no project on its receipts and operations, so none is any project's own", async () => {
    const { mapFile: _mapFile, ...old } = receipt(WORKER, "aaaaaaaaaaaaaaaa");
    const operation = {
      id: "op-1",
      keyId: KEY.name,
      environment: "prod",
      generation: "aaaaaaaaaaaaaaaa",
      startedAt: "2026-11-09T15:30:00Z",
      planned: [WORKER],
      done: [],
    };
    const fake = fakeFiles({
      [STATE]: JSON.stringify({ version: 2, receipts: [old], operations: [operation] }),
    });
    const state = await loadState(fake.files, STATE, VAULT_KINDS);
    expect(state).toEqual({
      version: 5,
      receipts: [{ ...old, mapFile: null }],
      operations: [{ ...operation, mapFile: null }],
      issued: [],
    });
    expect(receiptsFor(state, OWNER)).toEqual([]);
    expect(unfinishedOperations(state, OWNER)).toEqual([]);
  });

  test("a version 3 file's receipts record no item IDs, and a version 4 file keeps them", async () => {
    const ids = { vault: "vault-1", item: "item-1" };
    const saved = receipt(WORKER, "aaaaaaaaaaaaaaaa", { sourceIds: ids });
    const v3 = fakeFiles({
      [STATE]: JSON.stringify({ version: 3, receipts: [saved], operations: [] }),
    });
    expect((await loadState(v3.files, STATE, VAULT_KINDS)).receipts[0]?.sourceIds).toBeNull();
    const v4 = fakeFiles({
      [STATE]: JSON.stringify({ version: 4, receipts: [saved], operations: [] }),
    });
    expect((await loadState(v4.files, STATE, VAULT_KINDS)).receipts[0]?.sourceIds).toEqual(ids);
    const bad = JSON.stringify({
      version: 4,
      receipts: [{ ...saved, sourceIds: { vault: "vault-1" } }],
      operations: [],
    });
    await expect(loadState(fakeFiles({ [STATE]: bad }).files, STATE, VAULT_KINDS)).rejects.toThrow(
      '"receipts" must be a list',
    );
  });

  test("one receipt per destination secret: a write from another key replaces the last one", () => {
    let state = recordReceipt(emptyState(), receipt(WORKER, "aaaaaaaaaaaaaaaa"), KINDS);
    state = recordReceipt(state, receipt(WORKER, "bbbbbbbbbbbbbbbb", { keyId: "deploy" }), KINDS);
    expect(state.receipts).toEqual([receipt(WORKER, "bbbbbbbbbbbbbbbb", { keyId: "deploy" })]);
  });

  test("a GitHub secret in another case is the same secret; a Worker in another account isn't", () => {
    const aliased = receipt("github-actions:Acme/Billing:stripe_api_key", "bbbbbbbbbbbbbbbb");
    let state = recordReceipt(emptyState(), receipt(GITHUB, "aaaaaaaaaaaaaaaa"), KINDS);
    state = recordReceipt(state, aliased, KINDS);
    expect(state.receipts).toEqual([aliased]);

    const elsewhere = receipt(WORKER, "bbbbbbbbbbbbbbbb", {
      account: { pinned: "ffff", publisher: "acme", destinationAccount: "ffff" },
    });
    state = recordReceipt(
      recordReceipt(emptyState(), receipt(WORKER, "aaaaaaaaaaaaaaaa"), KINDS),
      elsewhere,
      KINDS,
    );
    expect(state.receipts).toHaveLength(2);
  });

  test("no schema version, bad JSON and bad receipts are clear errors", async () => {
    await expect(loadState(fakeFiles({ [STATE]: "{}" }).files, STATE, VAULT_KINDS)).rejects.toThrow(
      "schema version null",
    );
    await expect(loadState(fakeFiles({ [STATE]: "{" }).files, STATE, VAULT_KINDS)).rejects.toThrow(
      `${STATE}: the state file isn't valid JSON`,
    );
    const bad = JSON.stringify({ version: 1, receipts: [{ keyId: "k" }], operations: [] });
    await expect(loadState(fakeFiles({ [STATE]: bad }).files, STATE, VAULT_KINDS)).rejects.toThrow(
      '"receipts" must be a list',
    );
    const unnamed = JSON.stringify({
      version: 3,
      receipts: [{ ...receipt(WORKER, "aaaaaaaaaaaaaaaa"), mapFile: 7 }],
      operations: [],
    });
    await expect(
      loadState(fakeFiles({ [STATE]: unnamed }).files, STATE, VAULT_KINDS),
    ).rejects.toThrow('"receipts" must be a list');
  });

  test("an operation tracks done destinations, and a newer receipt replaces the older one", () => {
    let state = startOperation(emptyState(), {
      id: "op-1",
      keyId: KEY.name,
      environment: "prod",
      mapFile: KEY_MAP,
      generation: "aaaaaaaaaaaaaaaa",
      startedAt: "2026-11-09T15:30:00Z",
      planned: [WORKER, GITHUB],
    });
    state = recordReceipt(state, receipt(WORKER, "bbbbbbbbbbbbbbbb"), KINDS);
    state = recordReceipt(state, receipt(WORKER, "aaaaaaaaaaaaaaaa"), KINDS, "op-1");
    expect(receiptsFor(state, OWNER)).toEqual([receipt(WORKER, "aaaaaaaaaaaaaaaa")]);
    expect(unfinishedOperations(state, OWNER)).toEqual([
      expect.objectContaining({ id: "op-1", planned: [WORKER, GITHUB], done: [WORKER] }),
    ]);
    const [operation] = unfinishedOperations(state, OWNER);
    assert(operation);
    expect(() => startOperation(state, operation)).toThrow("operation op-1 already exists");
    expect(unfinishedOperations(finishOperation(state, "op-1"), OWNER)).toEqual([]);
  });

  test("another project's receipts and operations for the same variable and environment aren't this one's", () => {
    const web = { ...OWNER, mapFile: WEB_MAP };
    let state = startOperation(emptyState(), {
      id: "op-web",
      ...web,
      generation: "aaaaaaaaaaaaaaaa",
      startedAt: "2026-11-09T15:30:00Z",
      planned: [WORKER],
    });
    state = recordReceipt(state, receipt(GITHUB, "aaaaaaaaaaaaaaaa", { mapFile: WEB_MAP }), KINDS);
    expect(receiptsFor(state, OWNER)).toEqual([]);
    expect(unfinishedOperations(state, OWNER)).toEqual([]);
    expect(receiptsFor(state, web)).toHaveLength(1);
    expect(unfinishedOperations(state, web).map((o) => o.id)).toEqual(["op-web"]);
  });
});

describe("registry", () => {
  test("register and unregister write atomically, and repeating them changes nothing", async () => {
    const fake = fakeFiles();
    expect(await loadRegistry(fake.files, REGISTRY)).toEqual({
      version: 1,
      projects: [],
      shared: [],
    });

    await register(fake.files, REGISTRY, "/work/billing/");
    await register(fake.files, REGISTRY, "/work/web");
    const writes = fake.log.filter((l) => l.startsWith("write")).length;
    expect(await register(fake.files, REGISTRY, "/work/billing")).toEqual({
      version: 1,
      projects: ["/work/billing", "/work/web"],
      shared: [],
    });
    expect(fake.log.filter((l) => l.startsWith("write"))).toHaveLength(writes);
    expect(fake.log.filter((l) => l.startsWith("rename"))).toHaveLength(writes);

    await unregister(fake.files, REGISTRY, "/work/billing");
    expect((await loadRegistry(fake.files, REGISTRY)).projects).toEqual(["/work/web"]);
    expect([...fake.contents.keys()]).toEqual([REGISTRY]);
  });

  test("a relative path and another schema version are errors", async () => {
    await expect(register(fakeFiles().files, REGISTRY, "billing")).rejects.toThrow(
      'a project path must be absolute, got "billing"',
    );
    const fake = fakeFiles({ [REGISTRY]: JSON.stringify({ version: 0, projects: [] }) });
    await expect(loadRegistry(fake.files, REGISTRY)).rejects.toThrow(
      "the registry has schema version 0",
    );
  });
});

function withoutSource(receipt: Receipt): Omit<Receipt, "source" | "sourceIds" | "mapFile"> {
  const { keyId, environment, destinationId, generation, account, at, evidence } = receipt;
  return { keyId, environment, destinationId, generation, account, at, evidence };
}

describe("issued keys", () => {
  const issued = (overrides: Partial<Issued> = {}): Issued => ({
    ...OWNER,
    issuer: "resend",
    id: "key-new",
    generation: "bbbbbbbbbbbbbbbb",
    at: "2026-11-14T12:00:00Z",
    old: { id: "key-old", generation: "aaaaaaaaaaaaaaaa", revoked: false },
    ...overrides,
  });

  test("a version 4 file has none, and a version 5 file keeps them", async () => {
    const v4 = fakeFiles({
      [STATE]: JSON.stringify({ version: 4, receipts: [], operations: [] }),
    });
    expect((await loadState(v4.files, STATE, VAULT_KINDS)).issued).toEqual([]);
    const state = recordIssued(emptyState(), issued());
    const fake = fakeFiles();
    await saveState(fake.files, STATE, state);
    expect(await loadState(fake.files, STATE, VAULT_KINDS)).toEqual(state);
    const bad = JSON.stringify({ ...state, issued: [{ ...issued(), old: { id: 7 } }] });
    await expect(loadState(fakeFiles({ [STATE]: bad }).files, STATE, VAULT_KINDS)).rejects.toThrow(
      `"issued" must be a list of issued keys`,
    );
  });

  test("one per key, environment and project: a newer one replaces it", () => {
    let state = recordIssued(emptyState(), issued());
    state = recordIssued(state, issued({ mapFile: WEB_MAP }));
    state = recordIssued(state, issued({ id: "key-newer" }));
    expect(state.issued.map((i) => [i.mapFile, i.id])).toEqual([
      [WEB_MAP, "key-new"],
      [KEY_MAP, "key-newer"],
    ]);
    expect(issuedFor(state, OWNER)?.id).toBe("key-newer");
    expect(issuedFor(state, { ...OWNER, environment: "dev" })).toBeUndefined();
  });
});

describe("nextRotation", () => {
  const issued = (overrides: Partial<Issued> = {}): Issued => ({
    ...OWNER,
    issuer: "resend",
    id: "key-new",
    generation: "bbbbbbbbbbbbbbbb",
    at: "2026-11-14T12:00:00Z",
    old: { id: "key-old", generation: "aaaaaaaaaaaaaaaa", revoked: false },
    ...overrides,
  });
  const next = (found: Issued | undefined, generation: string, published = true) =>
    nextRotation({ issued: found, issuer: "resend", generation, published });

  test("no record: create, and the current key's ID is unknown", () => {
    expect(next(undefined, "aaaaaaaaaaaaaaaa")).toEqual({
      action: "create",
      current: null,
      abandoned: null,
    });
  });

  test("the vault holds the issued key, not yet published everywhere: resume", () => {
    const found = issued();
    expect(next(found, "bbbbbbbbbbbbbbbb", false)).toEqual({ action: "resume", issued: found });
  });

  test("published, but the old key isn't revoked yet: resume, to offer the revoke", () => {
    const found = issued();
    expect(next(found, "bbbbbbbbbbbbbbbb")).toEqual({ action: "resume", issued: found });
  });

  test("held for approval and the vault still has the old key: wait, create nothing", () => {
    const found = issued({ held: true });
    expect(next(found, "aaaaaaaaaaaaaaaa")).toEqual({ action: "wait", issued: found });
    expect(next(issued(), "aaaaaaaaaaaaaaaa")).toMatchObject({ action: "create" });
  });

  test("published and the old key revoked: the next rotation replaces the issued key", () => {
    const found = issued({ old: { id: "key-old", generation: "a", revoked: true } });
    expect(next(found, "bbbbbbbbbbbbbbbb")).toEqual({
      action: "create",
      current: "key-new",
      abandoned: null,
    });
  });

  test("published, and the old key's ID was never known: the next rotation replaces the issued key", () => {
    const found = issued({ old: { id: null, generation: "a", revoked: false } });
    expect(next(found, "bbbbbbbbbbbbbbbb")).toMatchObject({ action: "create", current: "key-new" });
  });

  test("the vault still holds the old value: the issued key was never saved", () => {
    const found = issued();
    expect(next(found, "aaaaaaaaaaaaaaaa")).toEqual({
      action: "create",
      current: "key-old",
      abandoned: found,
    });
  });

  test("the vault holds a value keypin didn't issue: the record is stale", () => {
    const found = issued();
    expect(next(found, "cccccccccccccccc")).toEqual({
      action: "create",
      current: null,
      abandoned: found,
    });
  });

  test("another issuer's record is stale", () => {
    const found = issued({ issuer: "openai" });
    expect(next(found, "bbbbbbbbbbbbbbbb")).toEqual({
      action: "create",
      current: null,
      abandoned: found,
    });
  });
});
