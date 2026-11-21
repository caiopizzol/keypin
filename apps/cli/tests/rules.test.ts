import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  destinations as destinationRules,
  issuers as issuerRules,
  pulls as pullRules,
  vaults as vaultRules,
} from "@keypin/connectors/rules";
import { destinations, issuers, pulls, vaults } from "../src/start";

const RULES = fileURLToPath(new URL("../../../packages/connectors/src/rules.ts", import.meta.url));
const PURE = new Set(["@keypin/core", "smol-toml"]);

async function browserBuild(entry: string): Promise<{ imports: string[]; text: string }> {
  const found = new Set<string>();
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    plugins: [
      {
        name: "imports",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
            found.add(path);
            return undefined;
          });
        },
      },
    ],
  });
  const text = (await Promise.all(result.outputs.map((output) => output.text()))).join("\n");
  return { imports: [...found].toSorted(), text };
}

describe("the rules half of every kind", () => {
  test("the CLI's issuers are the rules issuers, in the same order", () => {
    expect(issuers.map((kind) => kind.kind)).toEqual(issuerRules.map((kind) => kind.kind));
    expect(issuers).toMatchObject(issuerRules);
  });

  test("the CLI's vaults are the rules vaults, in the same order", () => {
    expect(vaults.map((kind) => kind.kind)).toEqual(vaultRules.map((kind) => kind.kind));
    expect(vaults).toMatchObject(vaultRules);
  });

  test("the CLI's destinations are the rules destinations, in the same order", () => {
    expect(destinations.map((kind) => kind.kind)).toEqual(
      destinationRules.map((kind) => kind.kind),
    );
    expect(destinations).toMatchObject(destinationRules);
  });

  test("the CLI pulls with the rules pulls", () => {
    expect(pulls).toEqual(pullRules);
  });

  test("a browser build of the rules imports no Node module or SDK", async () => {
    const { imports, text } = await browserBuild(RULES);
    expect(imports.filter((name) => !PURE.has(name))).toEqual([]);
    expect(text).not.toContain("node:");
  });
});
