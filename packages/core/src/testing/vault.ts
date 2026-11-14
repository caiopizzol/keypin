import { expect, test } from "vite-plus/test";
import { HeldForApproval, type KeyRef, type VaultBackend, type VaultScope } from "../contracts";
import { Secret } from "../secret";
import { caught, expectNoSentinel, SENTINEL } from "./leaks";

export interface VaultSubject {
  vault: VaultBackend;
  ref: KeyRef;
  scope: VaultScope;
  effects: readonly string[];
  hold?: () => void;
}

type Make = (sentinel: string) => VaultSubject | Promise<VaultSubject>;

const ROTATED = "2026-11-14";
const ITEM_KEYS = ["id", "tags", "title", "updatedAt"];

export function vaultContract(make: Make): void {
  test("the fake holds the sentinel at ref, and list names it without any value", async () => {
    const { vault, ref, scope, effects } = await make(SENTINEL);
    expect((await vault.read(ref)).equals(new Secret(SENTINEL))).toBe(true);
    const items = await vault.list(scope);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    expectNoSentinel(items, effects);
  });

  test("write then read gives back the value and the rotated date, or write rejects when capabilities.write is false", async () => {
    const { vault, ref, effects } = await make(SENTINEL);
    const value = new Secret(`${SENTINEL}-2`);
    if (!vault.capabilities.write) {
      const refused = await caught(vault.write(ref, value, { rotated: ROTATED }));
      expect((await vault.read(ref)).equals(new Secret(SENTINEL))).toBe(true);
      expect(effects).toEqual([]);
      expectNoSentinel(refused);
      return;
    }
    await vault.write(ref, value, { rotated: ROTATED });
    expect((await vault.read(ref)).equals(value)).toBe(true);
    expect(await vault.metadata(ref)).toEqual({ rotated: ROTATED });
    const item = await vault.readItem(ref);
    expect(item.secret.equals(value)).toBe(true);
    expect(item.ids).toEqual(await vault.itemIds(ref));
    expect(effects).toHaveLength(1);
    expectNoSentinel(effects, item.ids);
  });

  test("a write held for approval isn't reported as written", async (context) => {
    const { vault, ref, effects, hold } = await make(SENTINEL);
    if (!hold) return context.skip();
    hold();
    const held = await caught(vault.write(ref, new Secret(`${SENTINEL}-held`)));
    expect(held).toBeInstanceOf(HeldForApproval);
    expect((await vault.read(ref)).equals(new Secret(SENTINEL))).toBe(true);
    expectNoSentinel(held, effects);
  });
}
