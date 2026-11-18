import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@keypin/core";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const HEADER = 'import { expect } from "vite-plus/test";\n';
const COPIED = 'expect("x").toBe("one\\ntwo\\nthree\\nfour\\n");';

const allowed: Record<string, string> = {
  "one-line.ts": 'expect("x").toBe("one line");',
  "three-lines.ts": 'expect("x").toContain("first\\nsecond\\nthird\\n");',
  "three-joined.ts": 'expect("x").toBe(["a", "b", "c"].join("\\n"));',
  "trailing-empty-entry.ts": 'expect("x").toBe(["one", "two", "three", ""].join("\\n"));',
  "interpolated-separator.ts":
    'const indent = "  ";\nexpect("x").toBe(["one", "two", "three"].join(`\\n${indent}\\n`));',
  "dynamic-entry.ts":
    'declare const middle: string;\nexpect("x").toBe(["one", middle, "three", ""].join("\\n"));',
  "empty-spread.ts":
    'declare const rows: string[];\nexpect("x").toBe(["one", "two\\nthree", ...rows].join("\\n- "));',
  "not-an-assertion.ts":
    'declare const fixture: { toContain(text: string): void };\nfixture.toContain("one\\ntwo\\nthree\\nfour\\n");',
  "array-value.ts": 'expect(["a", "b", "c", "d"]).toEqual(["a", "b", "c", "d"]);',
  "number.ts": "expect(1).toBe(1);",
  "template-value-line.ts":
    'declare const middle: string;\nexpect("x").toBe(`one\\n${middle}\\nthree\\nfour`);',
  "joined-value-line.ts":
    'declare const middle: string;\nexpect("x").toBe(["one", middle, "three", "four"].join("\\n"));',
  "only-values.ts":
    "declare const a: string, b: string, c: string, d: string;\nexpect(a).toBe(`${a}\\n${b}\\n${c}\\n${d}`);",
  "implicit-separator.ts":
    'declare const first: string, last: string;\nexpect("x").toBe(["Names:", [first, last].join(), "Status:", "Ready"].join("\\n"));',
};

const rejected: Record<string, string> = {
  "string.ts": COPIED,
  "joined.ts": 'expect("x").toContain(["a", "b", "c", "d"].join("\\n"));',
  "joined-with-newlines.ts": 'expect("x").toBe(["one\\ntwo", "three\\nfour"].join("\\n"));',
  "template.ts": 'expect("x").toEqual(`one\ntwo\nthree\nfour`);',
  "negated.ts": 'expect("x").not.toBe("one\\ntwo\\nthree\\nfour\\n");',
  "soft.ts": 'expect.soft("x").toEqual("one\\ntwo\\nthree\\nfour\\n");',
  "interpolated-entry.ts":
    'declare const name: string;\nexpect("x").toBe([`one\\ntwo ${name}`, "three", "four"].join("\\n"));',
  "joined-with-spread.ts":
    'declare const rest: string[];\nexpect("x").toBe(["one", "two", "three", "four", ...rest].join("\\n"));',
  "template-with-value.ts": 'expect("x").toStrictEqual(`one\n${"two"}\nthree\nfour`);',
  "concatenated.ts": 'expect("x").toBe("one\\n" + "two\\n" + "three\\n" + "four\\n");',
};

const TESTS = "apps/cli/tests";
const outsideTests = ["apps/cli/src/copied.ts", "packages/connectors/tests/aws/sigv4.test.ts"];

let temp = "";
let flagged = new Map<string, number>();

beforeAll(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "keypin-no-hand-copied-output-")));
  const checkout = join(temp, "keypin");
  await mkdir(checkout, { recursive: true });
  for (const name of ["package.json", "vite.config.ts", "lint-plugin.ts"])
    await copyFile(join(REPO, name), join(checkout, name));
  await symlink(join(REPO, "node_modules"), join(checkout, "node_modules"));

  const files: Record<string, string> = {};
  for (const [name, code] of Object.entries({ ...allowed, ...rejected }))
    files[`${TESTS}/${name}`] = code;
  for (const path of outsideTests) files[path] = COPIED;
  for (const [path, code] of Object.entries(files)) {
    await mkdir(dirname(join(checkout, path)), { recursive: true });
    await writeFile(join(checkout, path), `${HEADER}${code}\nexport {};\n`);
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
    if (!isRecord(diagnostic) || diagnostic.code !== "keypin(no-hand-copied-output)") continue;
    const file = relative(checkout, resolve(checkout, String(diagnostic.filename)));
    flagged.set(file, (flagged.get(file) ?? 0) + 1);
  }
}, 30_000);

afterAll(() => rm(temp, { recursive: true, force: true }));

test.each(Object.entries(allowed))("a test may write %s: %s", (name) => {
  expect(flagged.get(`${TESTS}/${name}`)).toBeUndefined();
});

test.each(Object.entries(rejected))("a test may not write %s: %s", (name) => {
  expect(flagged.get(`${TESTS}/${name}`)).toBe(1);
});

test.each(outsideTests)("%s is not checked", (path) => {
  expect(flagged.get(path)).toBeUndefined();
});
