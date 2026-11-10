import { describe, expect, test } from "vite-plus/test";
import {
  dropRotation,
  emptyRotations,
  loadRotations,
  putRotation,
  type Rotation,
  saveRotations,
  unfinishedRotation,
} from "../src/index";
import { fakeFiles } from "./fixtures";

const PATH = "/state/keypin/rotations.json";

const rotation = (overrides: Partial<Rotation> = {}): Rotation => ({
  id: "r1",
  keyId: "site-deploy",
  environment: "prod",
  item: { kind: "1password", account: "my.1password.com", vault: "Private", item: "site token" },
  provider: "cloudflare-account-token",
  account: "11111111111111111111111111111111",
  stage: "issued",
  startedAt: "2026-11-10T12:00:00.000Z",
  updatedAt: "2026-11-10T12:00:01.000Z",
  old: { id: "a".repeat(32), name: "cicd", expiresOn: null, generation: "0123456789abcdef" },
  new: { id: "b".repeat(32), name: "cicd 2026-11-10", expiresOn: null, generation: null },
  ...overrides,
});

describe("rotations file", () => {
  test("a missing file is empty", async () => {
    expect(await loadRotations(fakeFiles().files, PATH)).toEqual(emptyRotations());
  });

  test("round-trips", async () => {
    const disk = fakeFiles();
    const data = putRotation(emptyRotations(), rotation());
    await saveRotations(disk.files, PATH, data);
    expect(await loadRotations(disk.files, PATH)).toEqual(data);
  });

  test("refuses another version and a malformed rotation", async () => {
    const disk = fakeFiles({
      [PATH]: JSON.stringify({ version: 2, rotations: [] }),
      "/b.json": JSON.stringify({ version: 1, rotations: [{ ...rotation(), stage: "done" }] }),
    });
    await expect(loadRotations(disk.files, PATH)).rejects.toThrow("schema version 2");
    await expect(loadRotations(disk.files, "/b.json")).rejects.toThrow(
      `"rotations" must be a list of rotations`,
    );
  });

  test("the unfinished one is any stage but revoked, for that key, environment and item", () => {
    const done = rotation({ id: "r0", stage: "revoked" });
    const open = rotation({ id: "r1", stage: "stored" });
    const dev = rotation({ id: "r2", environment: "dev" });
    const elsewhere = rotation({
      id: "r3",
      item: { ...rotation().item, item: "another project's token" },
    });
    const data = [done, open, dev, elsewhere].reduce(putRotation, emptyRotations());
    const item = rotation().item;
    expect(unfinishedRotation(data, "site-deploy", "prod", item)?.id).toBe("r1");
    expect(
      unfinishedRotation(dropRotation(data, "r1"), "site-deploy", "prod", item),
    ).toBeUndefined();
  });

  test("put replaces by ID", () => {
    const data = putRotation(
      putRotation(emptyRotations(), rotation()),
      rotation({ stage: "stored" }),
    );
    expect(data.rotations).toHaveLength(1);
    expect(data.rotations[0]?.stage).toBe("stored");
  });
});
