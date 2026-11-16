import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { parseMap } from "@keypin/core";
import { destinations, issuers, vaults } from "../src/start";

const ROOT = join(import.meta.dirname, "../../..");
const FILES = [
  "README.md",
  ...readdirSync(join(ROOT, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];
const FENCE = /^( *)```toml\n([\s\S]*?)^\1```/gm;
const KEY_TABLE = /^\[keys\.[^.\]\s]+(\.[^.\]\s]+)?\]$/m;
const VAULT_PIN = /^\[(1password|infisical)\]$/m;
const DOCS_PIN = '[1password]\naccount = "my.1password.com"\n\n';

const examples = FILES.flatMap((file) =>
  [...readFileSync(join(ROOT, file), "utf8").matchAll(FENCE)].flatMap(
    ([, indent = "", body = ""], index) => {
      const toml = body.replace(new RegExp(`^${indent}`, "gm"), "");
      if (!KEY_TABLE.test(toml)) return [];
      const map = VAULT_PIN.test(toml) ? toml : `${DOCS_PIN}${toml}`;
      return [{ name: `${file} toml block ${index + 1}`, map }];
    },
  ),
);

describe("keypin.toml examples in the docs", () => {
  test("the docs have examples with a [keys.<NAME>.<env>] table", () => {
    expect(examples.length).toBeGreaterThanOrEqual(4);
  });

  test.each(examples)("$name is a valid map", ({ name, map }) => {
    const parsed = parseMap(map, name, destinations, issuers, vaults);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  });
});
