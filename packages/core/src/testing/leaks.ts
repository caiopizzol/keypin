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
  const text = JSON.stringify(
    seen.map((each) => (each instanceof Error ? `${each.message} ${each.stack ?? ""}` : each)),
  );
  expect(text).not.toContain(SENTINEL);
}
