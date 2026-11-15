import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "vite-plus";

const SUITES = {
  destination: "destinationContract",
  issuer: "issuerContract",
  vault: "vaultContract",
};
type Role = keyof typeof SUITES;
const KINDS: Record<string, Role> = {
  DestinationKind: "destination",
  IssuerKind: "issuer",
  VaultKind: "vault",
};
const PACKAGE = "packages/connectors";
const HOW = "See docs/development.md#guardrails.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SKIPPED = new Set(["skip", "todo", "skipIf"]);
const X_WRAPPERS = new Set(["xdescribe", "xit", "xtest"]);

function skips(callee: unknown): boolean {
  if (!isRecord(callee)) return false;
  if (callee.type === "Identifier") return X_WRAPPERS.has(String(callee.name));
  if (callee.type === "CallExpression") return skips(callee.callee);
  if (callee.type !== "MemberExpression" || !isRecord(callee.property)) return false;
  return SKIPPED.has(String(callee.property.name)) || skips(callee.object);
}

type Binding = { local: string; namespace: boolean };

const calls = (callee: unknown, { local, namespace }: Binding, suite: string): boolean => {
  if (!isRecord(callee)) return false;
  if (!namespace) return callee.type === "Identifier" && callee.name === local;
  return (
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    isRecord(callee.object) &&
    callee.object.type === "Identifier" &&
    callee.object.name === local &&
    isRecord(callee.property) &&
    callee.property.name === suite
  );
};

function runs(node: unknown, binding: Binding, suite: string): boolean {
  if (Array.isArray(node)) return node.some((child) => runs(child, binding, suite));
  if (!isRecord(node)) return false;
  if (node.type === "CallExpression") {
    if (skips(node.callee)) return false;
    if (calls(node.callee, binding, suite)) return true;
  }
  return Object.values(node).some(
    (child) => typeof child === "object" && runs(child, binding, suite),
  );
}

const TYPE_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"]);

function readsValue(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((child) => readsValue(child, name));
  if (!isRecord(node) || node.type === "ImportDeclaration") return false;
  if (node.type === "Identifier") return node.name === name;
  const type = String(node.type);
  if (TYPE_WRAPPERS.has(type)) return readsValue(node.expression, name);
  if (type.startsWith("TS")) return false;
  if (node.type === "MemberExpression" && node.computed === false)
    return readsValue(node.object, name);
  if (node.type === "Property" && node.computed === false && node.shorthand === false)
    return readsValue(node.value, name);
  return Object.entries(node).some(
    ([key, child]) =>
      !["typeAnnotation", "typeArguments", "typeParameters", "returnType"].includes(key) &&
      typeof child === "object" &&
      readsValue(child, name),
  );
}

function imported(body: unknown[], from: (source: string) => boolean, name?: string): Binding[] {
  const found: Binding[] = [];
  for (const statement of body) {
    if (!isRecord(statement) || statement.type !== "ImportDeclaration") continue;
    if (statement.importKind === "type") continue;
    if (!isRecord(statement.source) || !from(String(statement.source.value))) continue;
    if (!Array.isArray(statement.specifiers)) continue;
    for (const specifier of statement.specifiers) {
      if (!isRecord(specifier) || !isRecord(specifier.local)) continue;
      if (specifier.importKind === "type") continue;
      const local = String(specifier.local.name);
      const namespace = specifier.type === "ImportNamespaceSpecifier";
      const which = isRecord(specifier.imported) ? specifier.imported.name : undefined;
      if (name === undefined || namespace || which === name) found.push({ local, namespace });
    }
  }
  return found;
}

function roles(root: string, provider: string): Role[] {
  const found = new Set<Role>();
  const dir = join(root, PACKAGE, "src", provider);
  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts")) continue;
    const { program } = parseSync(file, readFileSync(join(dir, file), "utf8"));
    for (const statement of program.body) {
      if (!isRecord(statement) || statement.type !== "ImportDeclaration") continue;
      if (!isRecord(statement.source) || statement.source.value !== "@keypin/core") continue;
      if (!Array.isArray(statement.specifiers)) continue;
      for (const specifier of statement.specifiers) {
        const name = isRecord(specifier) && isRecord(specifier.imported) && specifier.imported.name;
        const role = typeof name === "string" ? KINDS[name] : undefined;
        if (role) found.add(role);
      }
    }
  }
  return [...found].sort();
}

export function connectors(root: string): { provider: string; roles: Role[] }[] {
  const src = join(root, PACKAGE, "src");
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => ({ provider: name, roles: roles(root, name) }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function strays(root: string): string[] {
  const src = join(root, PACKAGE, "src");
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map(
      ({ name }) =>
        `${PACKAGE}/src/${name}: ${PACKAGE}/src holds one folder per provider. Move it into its provider's folder, or into packages/core if providers share it.`,
    );
}

export function problems(root: string, provider: string, roles: Role[]): string[] {
  const found: string[] = [];
  const dir = `${PACKAGE}/src/${provider}`;
  const test = `${PACKAGE}/tests/${provider}/contract.test.ts`;
  if (roles.length === 0)
    return [
      `${dir}: no DestinationKind, IssuerKind or VaultKind imported from @keypin/core. A provider folder implements one, in kind.ts.`,
    ];
  const manifest: unknown = JSON.parse(readFileSync(join(root, PACKAGE, "package.json"), "utf8"));
  const exports = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
  const key = `./${provider}/testing`;
  const want = `./src/${provider}/testing.ts`;
  const testing = exports[key];
  const fix = `Put the fake in ${dir}/testing.ts and add "${key}": "${want}" to "exports" in ${PACKAGE}/package.json.`;
  if (typeof testing !== "string")
    found.push(`${dir}: package.json has no "${key}" export. ${fix}`);
  else if (testing !== want)
    found.push(`${dir}: package.json exports "${key}" as ${testing}, not ${want}. ${fix}`);
  else if (!existsSync(join(root, PACKAGE, testing)))
    found.push(`${dir}: package.json exports "${key}" as ${testing}, which doesn't exist. ${fix}`);

  const path = join(root, test);
  for (const role of roles) {
    const suite = SUITES[role];
    const add = `Add ${test} that calls ${suite}(...) from @keypin/core/testing with the fake from ${dir}/testing.ts.`;
    if (!existsSync(path)) {
      found.push(`${dir}: no ${test}. ${add}`);
      continue;
    }
    const { program, errors } = parseSync(path, readFileSync(path, "utf8"));
    if (errors.length > 0) {
      found.push(`${dir}: ${test} doesn't parse: ${errors[0]?.message}`);
      continue;
    }
    const locals = imported(program.body, (source) => source === "@keypin/core/testing", suite);
    if (!locals.some((binding) => runs(program.body, binding, suite)))
      found.push(`${dir}: ${test} doesn't run ${suite}. ${add}`);
    const fake = (source: string) =>
      source === `@keypin/connectors/${provider}/testing` ||
      source === `../../src/${provider}/testing` ||
      source === `../../src/${provider}/testing.ts`;
    if (!imported(program.body, fake).some(({ local }) => readsValue(program.body, local)))
      found.push(`${dir}: ${test} doesn't import its fake from ${dir}/testing.ts. ${add}`);
  }
  return [...new Set(found)];
}

if (import.meta.main) {
  const found = [
    ...strays("."),
    ...connectors(".").flatMap(({ provider, roles }) => problems(".", provider, roles)),
  ];
  if (found.length > 0) {
    process.stderr.write(
      `Every connector ships its fake and proves the shared contract. ${HOW}\n${found.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
