import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { readSecretspec } from "@keypin/core";
import { destinations, issuers, vaults } from "../src/start";

const ROOT = join(import.meta.dirname, "../../..");
const FILES = [
  "README.md",
  "skills/keypin/SKILL.md",
  ...readdirSync(join(ROOT, "docs"), { encoding: "utf8", recursive: true })
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];
const FENCE = /^( *)```toml\n([\s\S]*?)^\1```/gm;
const WHOLE = /^\[project\]$/m;
const KEYPIN = /^\[\[?tool\.keypin[.\]]/m;
const PROJECT = '[project]\nname = "docs"\n\n';
const VAULT = '[providers]\nvault = "onepassword://Acme"\n\n[defaults]\nproviders = ["vault"]\n\n';
const PROFILE = "[profiles.default]\n\n";

function filled(toml: string): string {
  const vault = /^\[(providers|defaults)\]$/m.test(toml) ? "" : VAULT;
  const profile = /^\[profiles\./m.test(toml) ? "" : PROFILE;
  return `${PROJECT}${vault}${profile}${toml}`;
}

const blocks = FILES.flatMap((file) =>
  [...readFileSync(join(ROOT, file), "utf8").matchAll(FENCE)].map(
    ([, indent = "", body = ""], index) => ({
      name: `${file} toml block ${index + 1}`,
      toml: body.replace(new RegExp(`^${indent}`, "gm"), ""),
    }),
  ),
);
const whole = blocks.filter(({ toml }) => WHOLE.test(toml));
const parts = blocks
  .filter(({ toml }) => !WHOLE.test(toml) && KEYPIN.test(toml))
  .map(({ name, toml }) => ({ name, toml: filled(toml) }));

describe("secretspec.toml examples in the docs", () => {
  test("the docs have whole files and [tool.keypin] tables to check", () => {
    expect(whole.length).toBeGreaterThanOrEqual(5);
    expect(parts.length).toBeGreaterThanOrEqual(15);
  });

  test.each(whole)("$name reads", ({ name, toml }) => {
    const parsed = readSecretspec(toml, name, destinations, issuers, vaults);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  });

  test.each(parts)(
    "$name reads, and declares each key its [tool.keypin] tables set",
    ({ name, toml }) => {
      const parsed = readSecretspec(toml, name, destinations, issuers, vaults);
      expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    },
  );
});
