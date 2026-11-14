import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@keypin/core";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const DECLARE = [
  "declare const error: Error;",
  "declare const item: { problem: string | null; kind: string };",
  "declare const body: { message: unknown };",
  "declare const name: string;",
  "declare const fallback: string;",
  "declare const cond: boolean;",
  "declare function messageOf(error: unknown): string;",
  "declare function retry(): void;",
  "declare function say(text: string): void;",
  "class SignInFailed extends Error { reason = { kind: 'other' } }",
  "",
].join("\n");

const branches = [
  'if (error.message.includes("sign-in failed")) retry();',
  'if (error?.message?.startsWith("401")) retry();',
  'if (error.message.endsWith("denied")) retry();',
  "if (error.message.match(/not found/)) retry();",
  'export const at = error.message.search("x");',
  "if (/sign-in failed/.test(error.message)) retry();",
  'if (error.message === "Account not found") retry();',
  'if ("Account not found" !== error.message) retry();',
  'if (error["message"].includes("x")) retry();',
  'if (error.message.toLowerCase().includes("x")) retry();',
  'if ((item.problem ?? "").includes("x")) retry();',
  'if (item.problem?.includes("sign-in failed")) retry();',
  'if (item.problem === "sign-in failed") retry();',
  'if (messageOf(error).includes("x")) retry();',
  'switch (error.message) { case "x": retry(); }',
  'const text = error.message; if (text === "Account not found") retry();',
  'const text = messageOf(error); if (text.includes("denied")) retry();',
  'const m = messageOf(error); const inner = /msg: (.+)/.exec(m)?.[1] ?? m; if (inner === "x") retry();',
  "if (/denied/.exec(error.message)) retry();",
  "const found = /denied/.exec(messageOf(error)); if (found) retry();",
  "if (/denied/.exec(error.message) !== null) retry();",
  "export const denied = !error.message.match(/denied/) ? 1 : 2;",
  'if ((fallback ?? error.message).includes("x")) retry();',
  'if ((fallback || error.message) === "x") retry();',
  'if ((cond ? error.message : "").startsWith("x")) retry();',
  "const denied = !!error.message.match(/denied/); if (denied) retry();",
  "export function classify(): boolean { return !!error.message.match(/denied/); }",
  "export function classify(): boolean { return Boolean(error.message.match(/denied/)); }",
  "export const go = () => error.message.match(/denied/) && retry();",
  "export const go = () => /denied/.exec(messageOf(error)) || retry();",
];

const allowed = [
  "if (error instanceof SignInFailed) retry();",
  'if (error instanceof SignInFailed && error.reason.kind === "other") retry();',
  "say(`failed: ${error.message}`);",
  'export const first = error.message.replace(/^Invalid: /, "").split("\\n")[0];',
  'if (typeof body.message === "string") say(body.message);',
  "if (item.problem !== null) retry();",
  'if (name.includes("x") || /^\\w+$/.test(name)) retry();',
  'if (item.kind === "never-published") retry();',
  "export const found = error.message.match(/not found/);",
  "const found = /'([^']+)'/.exec(messageOf(error))?.[1]; say(found ? `the package ${found}` : \"a package\");",
  'const label = name; if (label === "x") retry();',
];

const fileOf = (kind: string, index: number) => `apps/cli/src/${kind}-${index}.ts`;
const inside = "packages/vault-acme/src/helper.ts";
const outside = [
  "apps/cli/tests/helper.ts",
  "packages/vault-acme/tests/helper.ts",
  "scripts/helper.ts",
  "packages/vault-1password/src/backend.ts",
];

let temp = "";
let flagged = new Map<string, string[]>();

beforeAll(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "keypin-error-text-")));
  const checkout = join(temp, "keypin");
  await mkdir(checkout, { recursive: true });
  for (const name of ["package.json", "vite.config.ts", "lint-plugin.ts"])
    await copyFile(join(REPO, name), join(checkout, name));
  await symlink(join(REPO, "node_modules"), join(checkout, "node_modules"));

  const files: Record<string, string> = {};
  branches.forEach((code, index) => (files[fileOf("branch", index)] = code));
  allowed.forEach((code, index) => (files[fileOf("allowed", index)] = code));
  for (const path of [inside, ...outside]) files[path] = branches[0] ?? "";
  for (const [path, code] of Object.entries(files)) {
    await mkdir(dirname(join(checkout, path)), { recursive: true });
    await writeFile(join(checkout, path), `${DECLARE}${code}\nexport {};\n`);
  }

  const lint = spawnSync(
    process.execPath,
    [join(checkout, "node_modules/.bin/vp"), "lint", "-f", "json", ...Object.keys(files)],
    { cwd: checkout, encoding: "utf8" },
  );
  const report: unknown = JSON.parse(lint.stdout);
  if (!isRecord(report) || !Array.isArray(report.diagnostics))
    throw new Error("vp lint printed no diagnostics list");
  flagged = new Map();
  for (const diagnostic of report.diagnostics) {
    if (!isRecord(diagnostic) || diagnostic.code !== "keypin(no-error-text-matching)") continue;
    const file = relative(checkout, resolve(checkout, String(diagnostic.filename)));
    flagged.set(file, [...(flagged.get(file) ?? []), String(diagnostic.message)]);
  }
}, 30_000);

afterAll(() => rm(temp, { recursive: true, force: true }));

test.each(branches.map((code, index) => [code, index] as const))("flags %s", (_code, index) => {
  expect(flagged.get(fileOf("branch", index))).toHaveLength(1);
});

test.each(allowed.map((code, index) => [code, index] as const))("allows %s", (_code, index) => {
  expect(flagged.get(fileOf("allowed", index))).toBeUndefined();
});

test("checks package source", () => {
  expect(flagged.get(inside)).toHaveLength(1);
});

test.each(outside)("doesn't check %s", (path) => {
  expect(flagged.get(path)).toBeUndefined();
});

test("the message says what to do instead and where to read more", () => {
  expect(flagged.get(fileOf("branch", 0))?.[0]).toMatch(
    /typed error from @keypin\/core.*instanceof.*docs\/development\.md#guardrails/,
  );
});
