import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "vite-plus";

const SUITES = {
  destination: "destinationContract",
  issuer: "issuerContract",
  vault: "vaultContract",
};
type Role = keyof typeof SUITES;
const CONNECTOR = /^(destination|issuer|vault)-[a-z0-9-]+$/;
const HOW = "See docs/development.md#guardrails.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRole = (value: string): value is Role => value in SUITES;

const TESTING = ["./src/testing.ts", "./src/testing/index.ts"];
const SKIPPED = new Set(["skip", "todo", "skipIf"]);
const X_WRAPPERS = new Set(["xdescribe", "xit", "xtest"]);

function skips(callee: unknown): boolean {
  if (!isRecord(callee)) return false;
  if (callee.type === "Identifier") return X_WRAPPERS.has(String(callee.name));
  if (callee.type === "CallExpression") return skips(callee.callee);
  if (callee.type !== "MemberExpression" || !isRecord(callee.property)) return false;
  return SKIPPED.has(String(callee.property.name)) || skips(callee.object);
}

function runs(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((child) => runs(child, name));
  if (!isRecord(node)) return false;
  if (node.type === "CallExpression") {
    if (skips(node.callee)) return false;
    if (isRecord(node.callee) && node.callee.type === "Identifier" && node.callee.name === name)
      return true;
  }
  return Object.values(node).some((child) => typeof child === "object" && runs(child, name));
}

function imported(body: unknown[], from: (source: string) => boolean, name?: string): string[] {
  const locals: string[] = [];
  for (const statement of body) {
    if (!isRecord(statement) || statement.type !== "ImportDeclaration") continue;
    if (!isRecord(statement.source) || !from(String(statement.source.value))) continue;
    if (!Array.isArray(statement.specifiers)) continue;
    for (const specifier of statement.specifiers) {
      if (!isRecord(specifier) || !isRecord(specifier.local)) continue;
      const which = isRecord(specifier.imported) ? specifier.imported.name : undefined;
      if (name === undefined || which === name) locals.push(String(specifier.local.name));
    }
  }
  return locals;
}

export function connectors(root: string): { dir: string; role: Role }[] {
  const found: { dir: string; role: Role }[] = [];
  for (const base of ["packages", "packages/connectors"]) {
    const parent = join(root, base);
    if (!existsSync(parent)) continue;
    for (const name of readdirSync(parent)) {
      const role = CONNECTOR.exec(name)?.[1];
      if (role && isRole(role)) found.push({ dir: join(base, name), role });
    }
  }
  return found;
}

export function problems(root: string, dir: string, role: Role): string[] {
  const found: string[] = [];
  const suite = SUITES[role];
  const manifest: unknown = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  const exports = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
  const testing = exports["./testing"];
  const fix = `Put the fake ${role} in src/testing.ts and add "./testing": "./src/testing.ts" to "exports".`;
  if (typeof testing !== "string")
    found.push(`${dir}: package.json has no "./testing" export. ${fix}`);
  else if (!TESTING.includes(testing))
    found.push(
      `${dir}: package.json exports "./testing" as ${testing}, not the testing module. ${fix}`,
    );
  else if (!existsSync(join(root, dir, testing)))
    found.push(
      `${dir}: package.json exports "./testing" as ${testing}, which doesn't exist. ${fix}`,
    );

  const path = join(root, dir, "tests/contract.test.ts");
  const add = `Add ${dir}/tests/contract.test.ts that calls ${suite}(...) from @keypin/core/testing with the fake from src/testing.ts.`;
  if (!existsSync(path)) {
    found.push(`${dir}: no tests/contract.test.ts. ${add}`);
    return found;
  }
  const { program, errors } = parseSync(path, readFileSync(path, "utf8"));
  if (errors.length > 0) {
    found.push(`${dir}: tests/contract.test.ts doesn't parse: ${errors[0]?.message}`);
    return found;
  }
  const locals = imported(program.body, (source) => source === "@keypin/core/testing", suite);
  if (!locals.some((local) => runs(program.body, local)))
    found.push(`${dir}: tests/contract.test.ts doesn't run ${suite}. ${add}`);
  const name = isRecord(manifest) ? manifest.name : undefined;
  const fake = (source: string) =>
    source === `${String(name)}/testing` ||
    /^\.\.\/src\/testing(\.ts|\/index(\.ts)?)?$/.test(source);
  if (imported(program.body, fake).length === 0)
    found.push(
      `${dir}: tests/contract.test.ts doesn't import its fake from ../src/testing. ${add}`,
    );
  return found;
}

if (import.meta.main) {
  const found = connectors(".").flatMap(({ dir, role }) => problems(".", dir, role));
  if (found.length > 0) {
    process.stderr.write(
      `Every connector ships its fake and proves the shared contract. ${HOW}\n${found.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
