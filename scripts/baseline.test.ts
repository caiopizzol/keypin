import { describe, expect, test } from "vite-plus/test";
import { raisedTotal } from "./baseline";

const BASELINE = "scripts/counts.json";

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
