import { expect, test } from "vite-plus/test";
import { fitKeyName, keyBaseName } from "../src/index";

test("a key's default name is its project, variable and profile, as one lowercase word", () => {
  expect(keyBaseName("acme-web", "RESEND_API_KEY", "production")).toBe(
    "acme-web-resend-api-key-production",
  );
  expect(keyBaseName("Acme Web", "API_KEY", "dev")).toBe("acme-web-api-key-dev");
});

test("a long name keeps its start and the run's tag", () => {
  expect(fitKeyName("acme-api-webhooks-openai-api-key-production-a1b2c3", 40)).toBe(
    "acme-api-webhooks-openai-api-key-a1b2c3",
  );
});

test("the cut drops a trailing separator before the tag", () => {
  expect(fitKeyName("acme-api-webhooks-openai-api-key-production-a1b2c3", 32)).toBe(
    "acme-api-webhooks-openai-a1b2c3",
  );
});

test("the cut never splits a character in two", () => {
  const fitted = fitKeyName(`${"a".repeat(37)}😀-key-prod-a1b2c3`, 45);
  expect(fitted).toBe(`${"a".repeat(37)}-a1b2c3`);
});
