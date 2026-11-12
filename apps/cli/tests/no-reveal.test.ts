import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const VP = join(REPO, "node_modules/.bin/vp");
const SECRET = "type Secret = { reveal(): string };\ndeclare const secret: Secret;\n";

const leaks: Record<string, string> = {
  "dot.ts": "export const value = secret.reveal();",
  "optional.ts": "export const value = secret?.reveal();",
  "bracket.ts": 'export const value = secret["reveal"]();',
  "template.ts": "export const value = secret[`reveal`]();",
  "method-as-value.ts": "export const show = secret.reveal;",
  "destructure.ts": "const { reveal } = secret;\nexport const value = reveal();",
  "destructure-computed.ts": 'const { ["reveal"]: show } = secret;\nexport const value = show();',
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
];

const COMMAND = "apps/cli/src/commands/import.ts";
const OTHER_METHODS =
  "type Secret = { equals(o: Secret): boolean; isEmpty(): boolean; includes(t: string): boolean };\ndeclare const a: Secret;\ndeclare const b: Secret;\nexport const ok = a.equals(b) || a.isEmpty() || a.includes('$');";

let root = "";
let flagged = new Map<string, number>();

async function put(path: string, code: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), SECRET + code + "\n");
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keypin-no-reveal-")));
  const files: Record<string, string> = {
    [join("other-methods", COMMAND)]: OTHER_METHODS,
  };
  for (const [name, code] of Object.entries(leaks))
    files[join("leaks", dirname(COMMAND), name)] = code;
  for (const path of [...allowed, ...forbidden])
    files[join("places", path)] = "export const value = secret.reveal();";
  for (const [path, code] of Object.entries(files)) await put(path, code);

  const lint = spawnSync(
    process.execPath,
    [
      VP,
      "lint",
      "-c",
      "vite.config.ts",
      "-f",
      "json",
      ...Object.keys(files).map((path) => join(root, path)),
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  const report: unknown = JSON.parse(lint.stdout);
  flagged = new Map();
  if (typeof report !== "object" || report === null || !("diagnostics" in report))
    throw new Error("vp lint printed no diagnostics list");
  const diagnostics = report.diagnostics;
  if (!Array.isArray(diagnostics)) throw new Error("vp lint diagnostics is not a list");
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== "keypin(no-reveal)") continue;
    const file = relative(root, String(diagnostic.filename));
    flagged.set(file, (flagged.get(file) ?? 0) + 1);
  }
}, 30_000);

afterAll(() => rm(root, { recursive: true, force: true }));

test.each(Object.keys(leaks))("a command can't reach the value through %s", (name) => {
  expect(flagged.get(join("leaks", dirname(COMMAND), name))).toBe(1);
});

test.each(allowed)("%s may reveal", (path) => {
  expect(flagged.get(join("places", path))).toBeUndefined();
});

test.each(forbidden)("%s may not reveal", (path) => {
  expect(flagged.get(join("places", path))).toBe(1);
});

test("Secret's own comparisons and other objects' reveal props pass", () => {
  expect(flagged.get(join("other-methods", COMMAND))).toBeUndefined();
});
