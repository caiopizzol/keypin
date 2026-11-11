import { assert, describe, expect, test } from "vite-plus/test";
import {
  emptyState,
  finishOperation,
  loadRegistry,
  loadState,
  receiptsFor,
  recordReceipt,
  register,
  saveState,
  startOperation,
  unfinishedOperations,
  unregister,
  type Receipt,
} from "../src/index";
import { fakeFiles, GITHUB, KEY, receipt, WORKER } from "./fixtures";

const STATE = "/state/keypin/state.json";
const REGISTRY = "/config/keypin/registry.json";

describe("state", () => {
  test("a missing file is an empty state", async () => {
    expect(await loadState(fakeFiles().files, STATE)).toEqual(emptyState());
  });

  test("saving writes a temporary file, then renames it over the state file", async () => {
    const fake = fakeFiles();
    const state = recordReceipt(emptyState(), receipt(WORKER, "aaaaaaaaaaaaaaaa"));
    await saveState(fake.files, STATE, state);
    expect(fake.log).toHaveLength(2);
    const [write, rename] = fake.log;
    assert(write);
    const temporary = write.replace(/^write /, "");
    expect(temporary).toMatch(/^\/state\/keypin\/state\.json\..+\.tmp$/);
    expect(rename).toBe(`rename ${temporary} -> ${STATE}`);
    expect([...fake.contents.keys()]).toEqual([STATE]);
    expect(await loadState(fake.files, STATE)).toEqual(state);
  });

  test("a crash before the rename leaves the old state whole", async () => {
    const before = recordReceipt(emptyState(), receipt(WORKER, "aaaaaaaaaaaaaaaa"));
    const fake = fakeFiles({ [STATE]: JSON.stringify(before) });
    fake.fail("rename");
    const after = recordReceipt(before, receipt(GITHUB, "aaaaaaaaaaaaaaaa"));
    await expect(saveState(fake.files, STATE, after)).rejects.toThrow("crashed before rename");
    expect(await loadState(fake.files, STATE)).toEqual(before);
  });

  test("a source saved before references named a field reads as the password field", async () => {
    const saved = receipt(WORKER, "aaaaaaaaaaaaaaaa");
    assert(saved.source);
    const { section: _section, field: _field, ...before } = saved.source;
    const fake = fakeFiles({
      [STATE]: JSON.stringify({
        version: 2,
        receipts: [{ ...saved, source: before }],
        operations: [],
      }),
    });
    expect((await loadState(fake.files, STATE)).receipts[0]?.source).toEqual(saved.source);
  });

  test("another schema version gives a clear error", async () => {
    const fake = fakeFiles({
      [STATE]: JSON.stringify({ version: 3, receipts: [], operations: [] }),
    });
    await expect(loadState(fake.files, STATE)).rejects.toThrow(
      `${STATE}: the state file has schema version 3, and this keypin reads version 1 or 2`,
    );
  });

  test("a version 1 file loads, with receipts that don't record their item, and saves as version 2", async () => {
    const old = withoutSource(receipt(WORKER, "aaaaaaaaaaaaaaaa"));
    const fake = fakeFiles({
      [STATE]: JSON.stringify({ version: 1, receipts: [old], operations: [] }),
    });
    const state = await loadState(fake.files, STATE);
    expect(state).toEqual({
      version: 2,
      receipts: [{ ...old, source: null }],
      operations: [],
    });
    await saveState(fake.files, STATE, state);
    expect(await loadState(fake.files, STATE)).toEqual(state);
    expect(fake.contents.get(STATE)).toContain('"version": 2');
  });

  test("one receipt per destination secret: a write from another key replaces the last one", () => {
    let state = recordReceipt(emptyState(), receipt(WORKER, "aaaaaaaaaaaaaaaa"));
    state = recordReceipt(state, receipt(WORKER, "bbbbbbbbbbbbbbbb", { keyId: "deploy" }));
    expect(state.receipts).toEqual([receipt(WORKER, "bbbbbbbbbbbbbbbb", { keyId: "deploy" })]);
  });

  test("a GitHub secret in another case is the same secret; a Worker in another account isn't", () => {
    const aliased = receipt("github-actions:Acme/Billing:stripe_api_key", "bbbbbbbbbbbbbbbb");
    let state = recordReceipt(emptyState(), receipt(GITHUB, "aaaaaaaaaaaaaaaa"));
    state = recordReceipt(state, aliased);
    expect(state.receipts).toEqual([aliased]);

    const elsewhere = receipt(WORKER, "bbbbbbbbbbbbbbbb", {
      account: { pinned: "ffff", publisher: "acme", destinationAccount: "ffff" },
    });
    state = recordReceipt(
      recordReceipt(emptyState(), receipt(WORKER, "aaaaaaaaaaaaaaaa")),
      elsewhere,
    );
    expect(state.receipts).toHaveLength(2);
  });

  test("no schema version, bad JSON and bad receipts are clear errors", async () => {
    await expect(loadState(fakeFiles({ [STATE]: "{}" }).files, STATE)).rejects.toThrow(
      "schema version null",
    );
    await expect(loadState(fakeFiles({ [STATE]: "{" }).files, STATE)).rejects.toThrow(
      `${STATE}: the state file isn't valid JSON`,
    );
    const bad = JSON.stringify({ version: 1, receipts: [{ keyId: "k" }], operations: [] });
    await expect(loadState(fakeFiles({ [STATE]: bad }).files, STATE)).rejects.toThrow(
      '"receipts" must be a list',
    );
  });

  test("an operation tracks done destinations, and a newer receipt replaces the older one", () => {
    let state = startOperation(emptyState(), {
      id: "op-1",
      keyId: KEY.name,
      environment: "prod",
      generation: "aaaaaaaaaaaaaaaa",
      startedAt: "2026-11-09T15:30:00Z",
      planned: [WORKER, GITHUB],
    });
    state = recordReceipt(state, receipt(WORKER, "bbbbbbbbbbbbbbbb"));
    state = recordReceipt(state, receipt(WORKER, "aaaaaaaaaaaaaaaa"), "op-1");
    expect(receiptsFor(state, KEY.name, "prod")).toEqual([receipt(WORKER, "aaaaaaaaaaaaaaaa")]);
    expect(unfinishedOperations(state, KEY.name, "prod")).toEqual([
      expect.objectContaining({ id: "op-1", planned: [WORKER, GITHUB], done: [WORKER] }),
    ]);
    const [operation] = unfinishedOperations(state, KEY.name, "prod");
    assert(operation);
    expect(() => startOperation(state, operation)).toThrow("operation op-1 already exists");
    expect(unfinishedOperations(finishOperation(state, "op-1"), KEY.name, "prod")).toEqual([]);
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

function withoutSource(receipt: Receipt): Omit<Receipt, "source"> {
  const { keyId, environment, destinationId, generation, account, at, evidence } = receipt;
  return { keyId, environment, destinationId, generation, account, at, evidence };
}
