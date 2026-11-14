import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { connectors, problems } from "./check-connectors";

const MANIFEST = JSON.stringify({
  name: "@keypin/acme",
  exports: { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
});
const FAKE = 'import { fake } from "../src/testing";\n';
const CONTRACT = (suite: string, body = `${suite}(() => fake());`) =>
  `import { describe } from "vite-plus/test";\nimport { ${suite} } from "@keypin/core/testing";\n${FAKE}describe("c", () => {\n  ${body}\n});\n`;

let root = "";
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const connector = (dir: string, suite: string) => {
  put(`${dir}/package.json`, MANIFEST);
  put(`${dir}/src/testing.ts`, "export {};\n");
  put(`${dir}/tests/contract.test.ts`, CONTRACT(suite));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keypin-connectors-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("connectors", () => {
  test("finds each role in packages/ and packages/connectors/, and skips the rest", () => {
    connector("packages/vault-acme", "vaultContract");
    connector("packages/connectors/issuer-acme", "issuerContract");
    put("packages/core/package.json", "{}");
    put("packages/cli/package.json", "{}");
    expect(connectors(root)).toEqual([
      { dir: "packages/vault-acme", role: "vault" },
      { dir: "packages/connectors/issuer-acme", role: "issuer" },
    ]);
  });
});

describe("problems", () => {
  test("a connector with its fake and contract test passes", () => {
    connector("packages/destination-acme", "destinationContract");
    expect(problems(root, "packages/destination-acme", "destination")).toEqual([]);
  });

  test("asks for a ./testing export", () => {
    connector("packages/vault-acme", "vaultContract");
    put("packages/vault-acme/package.json", JSON.stringify({ exports: { ".": "./src/index.ts" } }));
    expect(problems(root, "packages/vault-acme", "vault")).toEqual([
      'packages/vault-acme: package.json has no "./testing" export. Put the fake vault in src/testing.ts and add "./testing": "./src/testing.ts" to "exports".',
    ]);
  });

  test("asks for the file ./testing points at", () => {
    connector("packages/vault-acme", "vaultContract");
    rmSync(join(root, "packages/vault-acme/src/testing.ts"));
    expect(problems(root, "packages/vault-acme", "vault")[0]).toContain(
      'exports "./testing" as ./src/testing.ts, which doesn\'t exist',
    );
  });

  test("./testing must point at the testing module, not any file", () => {
    connector("packages/vault-acme", "vaultContract");
    put(
      "packages/vault-acme/package.json",
      JSON.stringify({ exports: { ".": "./src/index.ts", "./testing": "./src/index.ts" } }),
    );
    put("packages/vault-acme/src/index.ts", "export {};\n");
    expect(problems(root, "packages/vault-acme", "vault")).toEqual([
      'packages/vault-acme: package.json exports "./testing" as ./src/index.ts, not the testing module. Put the fake vault in src/testing.ts and add "./testing": "./src/testing.ts" to "exports".',
    ]);
  });

  test("src/testing/index.ts is a testing module too", () => {
    connector("packages/vault-acme", "vaultContract");
    put(
      "packages/vault-acme/package.json",
      JSON.stringify({ exports: { "./testing": "./src/testing/index.ts" } }),
    );
    put("packages/vault-acme/src/testing/index.ts", "export {};\n");
    expect(problems(root, "packages/vault-acme", "vault")).toEqual([]);
  });

  test.each([
    ["the package's ./testing export", 'import { fake } from "@keypin/acme/testing";\n'],
    ["src/testing/index", 'import { fake } from "../src/testing/index";\n'],
  ])("the fake may come from %s", (_from, line) => {
    connector("packages/vault-acme", "vaultContract");
    put(
      "packages/vault-acme/tests/contract.test.ts",
      CONTRACT("vaultContract").replace(FAKE, line),
    );
    expect(problems(root, "packages/vault-acme", "vault")).toEqual([]);
  });

  test("the contract test must import the fake from the testing module", () => {
    connector("packages/vault-acme", "vaultContract");
    put(
      "packages/vault-acme/tests/contract.test.ts",
      CONTRACT("vaultContract").replace(FAKE, 'import { fake } from "./fake";\n'),
    );
    expect(problems(root, "packages/vault-acme", "vault")).toEqual([
      "packages/vault-acme: tests/contract.test.ts doesn't import its fake from ../src/testing. Add packages/vault-acme/tests/contract.test.ts that calls vaultContract(...) from @keypin/core/testing with the fake from src/testing.ts.",
    ]);
  });

  test("asks for tests/contract.test.ts", () => {
    connector("packages/issuer-acme", "issuerContract");
    rmSync(join(root, "packages/issuer-acme/tests/contract.test.ts"));
    expect(problems(root, "packages/issuer-acme", "issuer")).toEqual([
      "packages/issuer-acme: no tests/contract.test.ts. Add packages/issuer-acme/tests/contract.test.ts that calls issuerContract(...) from @keypin/core/testing with the fake from src/testing.ts.",
    ]);
  });

  test("asks for the suite that matches the role", () => {
    connector("packages/issuer-acme", "vaultContract");
    expect(problems(root, "packages/issuer-acme", "issuer")[0]).toContain(
      "tests/contract.test.ts doesn't run issuerContract",
    );
  });

  test("an import that is never called doesn't count", () => {
    connector("packages/vault-acme", "vaultContract");
    put(
      "packages/vault-acme/tests/contract.test.ts",
      `import { vaultContract } from "@keypin/core/testing";\n${FAKE}void vaultContract;\n`,
    );
    expect(problems(root, "packages/vault-acme", "vault")).toHaveLength(1);
  });

  test.each([
    ["commented out", "// vaultContract(() => fake());"],
    ["block-commented", "/* vaultContract(() => fake()); */"],
    ["in describe.skip", 'describe.skip("s", () => { vaultContract(() => fake()); });'],
    ["in describe.todo", 'describe.todo("s", () => { vaultContract(() => fake()); });'],
    ["in it.skip", 'it.skip("s", () => { vaultContract(() => fake()); });'],
    ["in test.skip.each", 'test.skip.each([1])("s", () => { vaultContract(() => fake()); });'],
    ["in describe.skipIf", 'describe.skipIf(true)("s", () => { vaultContract(() => fake()); });'],
    ["in xdescribe", 'xdescribe("s", () => { vaultContract(() => fake()); });'],
    ["in xit", 'xit("s", () => { vaultContract(() => fake()); });'],
  ])("a contract %s doesn't count", (_how, body) => {
    connector("packages/vault-acme", "vaultContract");
    put("packages/vault-acme/tests/contract.test.ts", CONTRACT("vaultContract", body));
    expect(problems(root, "packages/vault-acme", "vault")).toEqual([
      expect.stringContaining("doesn't run vaultContract"),
    ]);
  });

  test("a contract under an alias still counts", () => {
    connector("packages/vault-acme", "vaultContract");
    put(
      "packages/vault-acme/tests/contract.test.ts",
      `import { vaultContract as contract } from "@keypin/core/testing";\n${FAKE}contract(() => fake());\n`,
    );
    expect(problems(root, "packages/vault-acme", "vault")).toEqual([]);
  });
});
