import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { repoPath } from "../../../lint-plugin";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const SECRET = "type Secret = { reveal(): string };\ndeclare const secret: Secret;\n";
const REVEALS = "export const value = secret.reveal();";

const leaks: Record<string, string> = {
  "leak-dot.ts": "export const value = secret.reveal();",
  "leak-optional.ts": "export const value = secret?.reveal();",
  "leak-bracket.ts": 'export const value = secret["reveal"]();',
  "leak-template.ts": "export const value = secret[`reveal`]();",
  "leak-method-as-value.ts": "export const show = secret.reveal;",
  "leak-destructure.ts": "const { reveal } = secret;\nexport const value = reveal();",
  "leak-destructure-computed.ts":
    'const { ["reveal"]: show } = secret;\nexport const value = show();',
};

const allowed = [
  "packages/vault-1password/src/backend.ts",
  "packages/destination-github/src/github.ts",
  "packages/destination-cloudflare/src/cloudflare.ts",
  "packages/provider-cloudflare/src/tokens.ts",
  "packages/core/src/secret.ts",
  "apps/cli/src/commands/run.ts",
  "apps/cli/tests/fakes.ts",
  "packages/core/tests/secret.test.ts",
];

const forbidden = [
  "apps/cli/src/commands/rotate.ts",
  "apps/cli/src/publishing.ts",
  "packages/core/src/plan.ts",
  "packages/vault-1password/scripts/dump.ts",
  "apps/cli/src/tests/helper.ts",
];

const COMMANDS = "apps/cli/src/commands";
const COMPARES = `${COMMANDS}/compare.ts`;
const OTHER_METHODS =
  "type Secret = { equals(o: Secret): boolean; isEmpty(): boolean; includes(t: string): boolean };\ndeclare const a: Secret;\ndeclare const b: Secret;\nexport const ok = a.equals(b) || a.isEmpty() || a.includes('$');";

let temp = "";
let flagged = new Map<string, number>();

beforeAll(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "keypin-no-reveal-")));
  const checkout = join(temp, "tests", "packages", "apps", "keypin");
  await mkdir(checkout, { recursive: true });
  for (const name of ["package.json", "vite.config.ts", "lint-plugin.ts"])
    await copyFile(join(REPO, name), join(checkout, name));
  await symlink(join(REPO, "node_modules"), join(checkout, "node_modules"));

  const files: Record<string, string> = { [COMPARES]: OTHER_METHODS };
  for (const [name, code] of Object.entries(leaks)) files[`${COMMANDS}/${name}`] = code;
  for (const path of [...allowed, ...forbidden]) files[path] = REVEALS;
  for (const [path, code] of Object.entries(files)) {
    await mkdir(dirname(join(checkout, path)), { recursive: true });
    await writeFile(join(checkout, path), SECRET + code + "\n");
  }

  const lint = spawnSync(
    process.execPath,
    [join(checkout, "node_modules/.bin/vp"), "lint", "-f", "json", ...Object.keys(files)],
    { cwd: checkout, encoding: "utf8" },
  );
  const report: unknown = JSON.parse(lint.stdout);
  if (typeof report !== "object" || report === null || !("diagnostics" in report))
    throw new Error("vp lint printed no diagnostics list");
  const diagnostics = report.diagnostics;
  if (!Array.isArray(diagnostics)) throw new Error("vp lint diagnostics is not a list");
  flagged = new Map();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== "keypin(no-reveal)") continue;
    const file = relative(checkout, resolve(checkout, String(diagnostic.filename)));
    flagged.set(file, (flagged.get(file) ?? 0) + 1);
  }
}, 30_000);

afterAll(() => rm(temp, { recursive: true, force: true }));

test.each(Object.keys(leaks))("a command can't reach the value through %s", (name) => {
  expect(flagged.get(`${COMMANDS}/${name}`)).toBe(1);
});

test.each(allowed)("%s may reveal", (path) => {
  expect(flagged.get(path)).toBeUndefined();
});

test.each(forbidden)("%s may not reveal", (path) => {
  expect(flagged.get(path)).toBe(1);
});

test("Secret's own comparisons pass", () => {
  expect(flagged.get(COMPARES)).toBeUndefined();
});

test("a Windows path is taken from the same repo root", () => {
  const plugin = "file:///C:/work/my%20keys/keypin/lint-plugin.ts";
  expect(repoPath("C:\\work\\my keys\\keypin\\apps\\cli\\tests\\fakes.ts", plugin)).toBe(
    "apps/cli/tests/fakes.ts",
  );
  expect(repoPath("C:\\tests\\keypin\\apps\\cli\\src\\main.ts", plugin)).toBe(
    "C:/tests/keypin/apps/cli/src/main.ts",
  );
});
