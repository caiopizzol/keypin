import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { baselineAt } from "./baseline";
import { BASELINE, LIMIT, lineCount, problems } from "./check-file-size";

const HOW =
  "Split it into a folder with one file per job, like apps/cli/src/commands/rotate/. See docs/development.md#guardrails.";

let root = "";
const put = (path: string, lines: number) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), "const a = 1;\n".repeat(lines));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keypin-file-size-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("lineCount", () => {
  test("counts lines with or without a final newline", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
  });
});

describe("problems", () => {
  test("the current tree passes", () => {
    const repo = join(import.meta.dirname, "..");
    expect(problems(repo, baselineAt(repo, BASELINE))).toEqual([]);
  });

  test("a new file at the limit passes", () => {
    put("apps/cli/src/commands/new.ts", LIMIT);
    expect(problems(root, {})).toEqual([]);
  });

  test("a new file over the limit fails, at any depth and in any package", () => {
    put("apps/cli/src/commands/rotate/big.ts", LIMIT + 1);
    put("packages/connectors/src/neon/neon.ts", LIMIT + 2);
    expect(problems(root, {})).toEqual([
      `apps/cli/src/commands/rotate/big.ts: ${LIMIT + 1} lines, more than ${LIMIT}. ${HOW}`,
      `packages/connectors/src/neon/neon.ts: ${LIMIT + 2} lines, more than ${LIMIT}. ${HOW}`,
    ]);
  });

  test("a listed file at its size passes", () => {
    put("packages/core/src/map.ts", 700);
    expect(problems(root, { "packages/core/src/map.ts": 700 })).toEqual([]);
  });

  test("a listed file that grows fails", () => {
    put("packages/core/src/map.ts", 701);
    expect(problems(root, { "packages/core/src/map.ts": 700 })).toEqual([
      `packages/core/src/map.ts: 701 lines, more than the 700 in ${BASELINE}. ${HOW}`,
    ]);
  });

  test("a listed file that shrinks must lower its entry", () => {
    put("packages/core/src/map.ts", 650);
    expect(problems(root, { "packages/core/src/map.ts": 700 })).toEqual([
      `packages/core/src/map.ts: 650 lines now, fewer than the 700 in ${BASELINE}. Lower it to 650 so it stays there.`,
    ]);
  });

  test("a listed file back under the limit, or deleted, must leave the list", () => {
    put("packages/core/src/map.ts", LIMIT);
    expect(
      problems(root, { "packages/core/src/map.ts": 700, "apps/cli/src/gone.ts": 500 }),
    ).toEqual([
      `apps/cli/src/gone.ts: ${LIMIT} lines or fewer now. Remove its entry from ${BASELINE}.`,
      `packages/core/src/map.ts: ${LIMIT} lines or fewer now. Remove its entry from ${BASELINE}.`,
    ]);
  });

  test("tests, scripts and other files aren't counted", () => {
    for (const path of [
      "apps/cli/tests/check.test.ts",
      "packages/core/tests/map.test.ts",
      "scripts/check-file-size.ts",
      "packages/core/src/notes.md",
    ])
      put(path, LIMIT + 1);
    expect(problems(root, {})).toEqual([]);
  });
});
