import { expect } from "vite-plus/test";

export const SENTINEL = "keypin-contract-sentinel-4f8e2a";

export async function caught(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("expected a rejection with an Error");
  return outcome;
}

export function expectNoSentinel(...seen: unknown[]): void {
  expect(sentinelPaths(seen)).toEqual([]);
}

function sentinelPaths(seen: unknown[]): string[] {
  const found = new Set<string>();
  const visited = new WeakSet<object>();
  const decoder = new TextDecoder();

  function visit(each: unknown, at: string): void {
    if (typeof each === "string") {
      if (each.includes(SENTINEL)) found.add(at);
      return;
    }
    if (typeof each !== "object" || each === null || visited.has(each)) return;
    visited.add(each);
    if (ArrayBuffer.isView(each) || each instanceof ArrayBuffer)
      return visit(decoder.decode(each), at);
    if (each instanceof Error) {
      visit(each.message, `${at}.message`);
      visit(each.stack, `${at}.stack`);
      visit(each.cause, `${at}.cause`);
    }
    if (each instanceof Map) {
      for (const [key, entry] of each) {
        visit(key, `${at}<key>`);
        visit(entry, `${at}<value>`);
      }
    }
    if (each instanceof Set) for (const entry of each) visit(entry, `${at}<value>`);
    for (const key of Reflect.ownKeys(each)) {
      const name = String(key);
      visit(name, `${at}<key ${name}>`);
      visit(read(each, key), `${at}.${name}`);
    }
  }

  visit(seen, "seen");
  return [...found];
}

function read(owner: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(owner, key);
  } catch {
    return undefined;
  }
}
