import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { connectors, problems, strays } from "./check-connectors";

const PACKAGE = "packages/connectors";
const SRC = `${PACKAGE}/src/acme`;
const TEST = `${PACKAGE}/tests/acme/contract.test.ts`;
const KIND = {
  destinationContract: "DestinationKind",
  issuerContract: "IssuerKind",
  vaultContract: "VaultKind",
};
const FAKE = 'import { fake } from "../../src/acme/testing";\n';
const CONTRACT = (suite: string, body = `${suite}(() => fake());`) =>
  `import { describe } from "vite-plus/test";\nimport { ${suite} } from "@keypin/core/testing";\n${FAKE}describe("c", () => {\n  ${body}\n});\n`;

let root = "";
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
let exported: Record<string, string> = {};
const manifest = (exports: Record<string, string>) => {
  exported = exports;
  put(`${PACKAGE}/package.json`, JSON.stringify({ name: "@keypin/connectors", exports }));
};
const connector = (provider: string, suite: keyof typeof KIND, kinds: string[] = [KIND[suite]]) => {
  manifest({
    ...exported,
    [`./${provider}`]: `./src/${provider}/index.ts`,
    [`./${provider}/testing`]: `./src/${provider}/testing.ts`,
  });
  put(
    `${PACKAGE}/src/${provider}/kind.ts`,
    `import type { ${kinds.join(", ")} } from "@keypin/core";\nexport {};\n`,
  );
  put(`${PACKAGE}/src/${provider}/testing.ts`, "export {};\n");
  put(
    `${PACKAGE}/tests/${provider}/contract.test.ts`,
    CONTRACT(suite).replaceAll("src/acme/", `src/${provider}/`),
  );
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keypin-connectors-"));
  exported = {};
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("connectors", () => {
  test("finds each provider folder and its roles from the kinds it imports from core", () => {
    connector("acme", "vaultContract");
    connector("beta", "issuerContract", ["IssuerKind", "DestinationKind"]);
    put(`${PACKAGE}/src/gamma/helper.ts`, 'import type { Secret } from "@keypin/core";\n');
    expect(connectors(root)).toEqual([
      { provider: "acme", roles: ["vault"] },
      { provider: "beta", roles: ["destination", "issuer"] },
      { provider: "gamma", roles: [] },
    ]);
  });

  test("a kind imported in a nested file counts", () => {
    connector("acme", "vaultContract", []);
    put(`${SRC}/kind.ts`, "export {};\n");
    put(`${SRC}/deep/kind.ts`, 'import { type VaultKind } from "@keypin/core";\n');
    expect(connectors(root)).toEqual([{ provider: "acme", roles: ["vault"] }]);
  });

  test("a file loose in src fails", () => {
    connector("acme", "vaultContract");
    put(`${PACKAGE}/src/shared.ts`, "export {};\n");
    expect(strays(root)).toEqual([
      `${PACKAGE}/src/shared.ts: ${PACKAGE}/src holds one folder per provider. Move it into its provider's folder, or into packages/core if providers share it.`,
    ]);
  });
});

describe("problems", () => {
  test("a provider with its fake and contract test passes", () => {
    connector("acme", "destinationContract");
    expect(problems(root, "acme", ["destination"])).toEqual([]);
  });

  test("a provider that implements no kind fails", () => {
    expect(problems(root, "acme", [])).toEqual([
      `${SRC}: no DestinationKind, IssuerKind or VaultKind imported from @keypin/core. A provider folder implements one, in kind.ts.`,
    ]);
  });

  test("asks for a ./<provider>/testing export", () => {
    connector("acme", "vaultContract");
    manifest({ "./acme": "./src/acme/index.ts" });
    expect(problems(root, "acme", ["vault"])).toEqual([
      `${SRC}: package.json has no "./acme/testing" export. Put the fake in ${SRC}/testing.ts and add "./acme/testing": "./src/acme/testing.ts" to "exports" in ${PACKAGE}/package.json.`,
    ]);
  });

  test("asks for the file ./<provider>/testing points at", () => {
    connector("acme", "vaultContract");
    rmSync(join(root, SRC, "testing.ts"));
    expect(problems(root, "acme", ["vault"])[0]).toContain(
      'exports "./acme/testing" as ./src/acme/testing.ts, which doesn\'t exist',
    );
  });

  test("./<provider>/testing must point at that folder's testing.ts", () => {
    connector("acme", "vaultContract");
    connector("beta", "vaultContract");
    manifest({ ...exported, "./acme/testing": "./src/beta/testing.ts" });
    expect(problems(root, "acme", ["vault"])).toEqual([
      `${SRC}: package.json exports "./acme/testing" as ./src/beta/testing.ts, not ./src/acme/testing.ts. Put the fake in ${SRC}/testing.ts and add "./acme/testing": "./src/acme/testing.ts" to "exports" in ${PACKAGE}/package.json.`,
    ]);
  });

  test("the fake may come from the package's ./<provider>/testing export", () => {
    connector("acme", "vaultContract");
    put(
      TEST,
      CONTRACT("vaultContract").replace(
        FAKE,
        'import { fake } from "@keypin/connectors/acme/testing";\n',
      ),
    );
    expect(problems(root, "acme", ["vault"])).toEqual([]);
  });

  test.each([
    ["a local file", 'import { fake } from "./fake";\n'],
    ["another provider's fake", 'import { fake } from "../../src/beta/testing";\n'],
    ["another provider's export", 'import { fake } from "@keypin/connectors/beta/testing";\n'],
  ])("the contract test must import its own provider's fake, not %s", (_from, line) => {
    connector("acme", "vaultContract");
    put(TEST, CONTRACT("vaultContract").replace(FAKE, line));
    expect(problems(root, "acme", ["vault"])).toEqual([
      `${SRC}: ${TEST} doesn't import its fake from ${SRC}/testing.ts. Add ${TEST} that calls vaultContract(...) from @keypin/core/testing with the fake from ${SRC}/testing.ts.`,
    ]);
  });

  test("asks for tests/<provider>/contract.test.ts", () => {
    connector("acme", "issuerContract");
    rmSync(join(root, TEST));
    expect(problems(root, "acme", ["issuer"])).toEqual([
      `${SRC}: no ${TEST}. Add ${TEST} that calls issuerContract(...) from @keypin/core/testing with the fake from ${SRC}/testing.ts.`,
    ]);
  });

  test("a contract test in the old place doesn't count", () => {
    connector("acme", "vaultContract");
    rmSync(join(root, TEST));
    put(`${PACKAGE}/tests/contract.test.ts`, CONTRACT("vaultContract"));
    expect(problems(root, "acme", ["vault"])[0]).toContain(`no ${TEST}`);
  });

  test("asks for the suite that matches the role", () => {
    connector("acme", "vaultContract");
    expect(problems(root, "acme", ["issuer"])[0]).toContain(`${TEST} doesn't run issuerContract`);
  });

  test("a provider with two roles runs both suites", () => {
    connector("acme", "issuerContract", ["IssuerKind", "DestinationKind"]);
    expect(problems(root, "acme", ["destination", "issuer"])).toEqual([
      expect.stringContaining(`${TEST} doesn't run destinationContract`),
    ]);
  });

  test("an import that is never called doesn't count", () => {
    connector("acme", "vaultContract");
    put(
      TEST,
      `import { vaultContract } from "@keypin/core/testing";\n${FAKE}void vaultContract;\nvoid fake;\n`,
    );
    expect(problems(root, "acme", ["vault"])).toEqual([
      expect.stringContaining("doesn't run vaultContract"),
    ]);
  });

  test.each([
    ["commented out", "void fake; // vaultContract(() => fake());"],
    ["block-commented", "void fake; /* vaultContract(() => fake()); */"],
    ["in describe.skip", 'describe.skip("s", () => { vaultContract(() => fake()); });'],
    ["in describe.todo", 'describe.todo("s", () => { vaultContract(() => fake()); });'],
    ["in it.skip", 'it.skip("s", () => { vaultContract(() => fake()); });'],
    ["in test.skip.each", 'test.skip.each([1])("s", () => { vaultContract(() => fake()); });'],
    ["in describe.skipIf", 'describe.skipIf(true)("s", () => { vaultContract(() => fake()); });'],
    ["in xdescribe", 'xdescribe("s", () => { vaultContract(() => fake()); });'],
    ["in xit", 'xit("s", () => { vaultContract(() => fake()); });'],
  ])("a contract %s doesn't count", (_how, body) => {
    connector("acme", "vaultContract");
    put(TEST, CONTRACT("vaultContract", body));
    expect(problems(root, "acme", ["vault"])).toEqual([
      expect.stringContaining("doesn't run vaultContract"),
    ]);
  });

  test.each([
    ["only as a type", 'import type { fake } from "../../src/acme/testing";\n'],
    ["only through type specifiers", 'import { type fake } from "../../src/acme/testing";\n'],
    ["but never used", 'import { other } from "../../src/acme/testing";\n'],
  ])("a fake imported %s doesn't count", (_how, line) => {
    connector("acme", "vaultContract");
    put(TEST, CONTRACT("vaultContract").replace(FAKE, line));
    expect(problems(root, "acme", ["vault"])).toEqual([
      expect.stringContaining(`doesn't import its fake from ${SRC}/testing.ts`),
    ]);
  });

  test("a fake used only in a type position doesn't count", () => {
    connector("acme", "vaultContract");
    put(TEST, CONTRACT("vaultContract", "vaultContract(() => ({}) as fake);"));
    expect(problems(root, "acme", ["vault"])).toEqual([
      expect.stringContaining(`doesn't import its fake from ${SRC}/testing.ts`),
    ]);
  });

  test("a fake used through a namespace import counts", () => {
    connector("acme", "vaultContract");
    put(
      TEST,
      CONTRACT("vaultContract", "vaultContract(() => fakes.fake());").replace(
        FAKE,
        'import * as fakes from "../../src/acme/testing";\n',
      ),
    );
    expect(problems(root, "acme", ["vault"])).toEqual([]);
  });

  const NAMESPACE = (body: string) =>
    `import { describe } from "vite-plus/test";\nimport * as testing from "@keypin/core/testing";\n${FAKE}describe("c", () => {\n  ${body}\n});\n`;

  test("a contract called through a namespace import counts", () => {
    connector("acme", "vaultContract");
    put(TEST, NAMESPACE("testing.vaultContract(() => fake());"));
    expect(problems(root, "acme", ["vault"])).toEqual([]);
  });

  test.each([
    ["the wrong suite", "testing.issuerContract(() => fake());"],
    ["in describe.skip", 'describe.skip("s", () => { testing.vaultContract(() => fake()); });'],
    ["in xit", 'xit("s", () => { testing.vaultContract(() => fake()); });'],
  ])("a namespace contract call to %s doesn't count", (_how, body) => {
    connector("acme", "vaultContract");
    put(TEST, NAMESPACE(body));
    expect(problems(root, "acme", ["vault"])).toEqual([
      expect.stringContaining("doesn't run vaultContract"),
    ]);
  });

  test("a contract under an alias still counts", () => {
    connector("acme", "vaultContract");
    put(
      TEST,
      `import { vaultContract as contract } from "@keypin/core/testing";\n${FAKE}contract(() => fake());\n`,
    );
    expect(problems(root, "acme", ["vault"])).toEqual([]);
  });
});
