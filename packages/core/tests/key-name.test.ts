import { expect, test } from "vite-plus/test";
import { fitKeyName } from "../src/index";

test("a long name keeps its start, the time and the run's tag", () => {
  expect(
    fitKeyName("acme-api WEBHOOKS_OPENAI_API_KEY production 2026-01-15T09:30Z a1b2c3", 50),
  ).toBe("acme-api WEBHOOKS_OPENAI… 2026-01-15T09:30Z a1b2c3");
});

test("the cut never splits a character in two", () => {
  const fitted = fitKeyName(`${"a".repeat(37)}😀 KEY prod 2026-01-15T09:30Z a1b2c3`, 64);
  expect(fitted).toBe(`${"a".repeat(37)}… 2026-01-15T09:30Z a1b2c3`);
});
