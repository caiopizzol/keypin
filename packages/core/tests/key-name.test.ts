import { expect, test } from "vite-plus/test";
import { fitKeyName } from "../src/index";

test("a long name keeps its start, the time and the run's tag", () => {
  expect(
    fitKeyName("orbit-ci PULLFROG_OPENAI_API_KEY production 2026-11-24T16:12Z 668dbf", 50),
  ).toBe("orbit-ci PULLFROG_OPENAI… 2026-11-24T16:12Z 668dbf");
});

test("the cut never splits a character in two", () => {
  const fitted = fitKeyName(`${"a".repeat(37)}😀 KEY prod 2026-11-24T16:12Z 668dbf`, 64);
  expect(fitted).toBe(`${"a".repeat(37)}… 2026-11-24T16:12Z 668dbf`);
});
