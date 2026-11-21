import { describe, expect, test } from "vite-plus/test";
import { raised, raisedTotal } from "./baseline";

const BASELINE = "scripts/counts.json";

describe("raised", () => {
  test("a count raised since the base branch fails", () => {
    expect(
      raised(
        { "apps/cli/src/commands/import.ts": 36 },
        { "apps/cli/src/commands/import.ts": 37 },
        BASELINE,
      ),
    ).toEqual([`apps/cli/src/commands/import.ts: ${BASELINE} raises it to 37, from 36.`]);
  });

  test("a file added since the base branch fails", () => {
    expect(raised({}, { "packages/core/src/vault.ts": 1 }, BASELINE)).toEqual([
      `packages/core/src/vault.ts: ${BASELINE} raises it to 1, from 0.`,
    ]);
  });

  test("a lowered or unchanged count passes", () => {
    expect(raised({ "a.ts": 3, "b.ts": 2 }, { "a.ts": 3, "b.ts": 1 }, BASELINE)).toEqual([]);
  });

  test("a base branch without a baseline passes, so the first one can land", () => {
    expect(raised(null, { "a.ts": 3 }, BASELINE)).toEqual([]);
  });
});

describe("raisedTotal", () => {
  test("a count that moves to another file passes", () => {
    expect(raisedTotal({ "a.ts": 3 }, { "a/one.ts": 2, "a/two.ts": 1 }, BASELINE)).toEqual([]);
  });

  test("a higher total fails", () => {
    expect(raisedTotal({ "a.ts": 3 }, { "a.ts": 2, "b.ts": 2 }, BASELINE)).toEqual([
      `${BASELINE} raises the total to 4, from 3.`,
    ]);
  });

  test("a base branch without a baseline passes", () => {
    expect(raisedTotal(null, { "a.ts": 3 }, BASELINE)).toEqual([]);
  });
});
