import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { readSecretspec } from "@keypin/core";
import { destinations, issuers, vaults } from "../src/start";

const ROOT = join(import.meta.dirname, "../../..");
const FILES = [
  "README.md",
  ...readdirSync(join(ROOT, "docs"), { encoding: "utf8", recursive: true })
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];
const FENCE = /^( *)```toml\n([\s\S]*?)^\1```/gm;
const SECRETSPEC = /^\[project\]$/m;

const examples = FILES.flatMap((file) =>
  [...readFileSync(join(ROOT, file), "utf8").matchAll(FENCE)].flatMap(
    ([, indent = "", body = ""], index) => {
      const toml = body.replace(new RegExp(`^${indent}`, "gm"), "");
      return SECRETSPEC.test(toml) ? [{ name: `${file} toml block ${index + 1}`, toml }] : [];
    },
  ),
);

describe("secretspec.toml examples in the docs", () => {
  test("the docs have a whole secretspec.toml example", () => {
    expect(examples.length).toBeGreaterThanOrEqual(1);
  });

  test.each(examples)("$name reads", ({ name, toml }) => {
    const parsed = readSecretspec(toml, name, destinations, issuers, vaults);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  });
});
