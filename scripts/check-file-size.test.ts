import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { BASELINE, exceptionsAt, LIMIT, lineCount, problems, sizes } from "./check-file-size";

const HOW = `Split it into a folder with one file per job, like apps/cli/src/commands/rotate/. If it is one job that doesn't split cleanly, add it to ${BASELINE} with its line count and why. See docs/development.md#guardrails.`;
const WHY = "one closure over shared state";

let root = "";
const put = (path: string, lines: number) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), "const a = 1;\n".repeat(lines));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keypin-file-size-"));
  Bun.spawnSync(["git", "init", "-q", root]);
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
    expect(problems(repo, exceptionsAt(repo))).toEqual([]);
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
    expect(problems(root, { "packages/core/src/map.ts": { lines: 700, why: WHY } })).toEqual([]);
  });

  test("a listed file may grow or shrink if its entry follows", () => {
    put("packages/core/src/map.ts", 701);
    put("packages/core/src/gaps.ts", 650);
    expect(
      problems(root, {
        "packages/core/src/gaps.ts": { lines: 700, why: WHY },
        "packages/core/src/map.ts": { lines: 700, why: WHY },
      }),
    ).toEqual([
      `packages/core/src/gaps.ts: 650 lines now, not the 700 in ${BASELINE}. Set "lines" to 650.`,
      `packages/core/src/map.ts: 701 lines now, not the 700 in ${BASELINE}. Set "lines" to 701.`,
    ]);
  });

  test("a listed file needs a why", () => {
    put("packages/core/src/map.ts", 700);
    expect(problems(root, { "packages/core/src/map.ts": { lines: 700, why: "" } })).toEqual([
      `packages/core/src/map.ts: its entry in ${BASELINE} has no "why". Say why it stays one file, or split it.`,
    ]);
  });

  test("a listed file back under the limit, or deleted, must leave the list", () => {
    put("packages/core/src/map.ts", LIMIT);
    expect(
      problems(root, {
        "packages/core/src/map.ts": { lines: 700, why: WHY },
        "apps/cli/src/gone.ts": { lines: 500, why: WHY },
      }),
    ).toEqual([
      `apps/cli/src/gone.ts: ${LIMIT} lines or fewer now. Remove its entry from ${BASELINE}.`,
      `packages/core/src/map.ts: ${LIMIT} lines or fewer now. Remove its entry from ${BASELINE}.`,
    ]);
  });

  test("entries are read with their size and why", () => {
    mkdirSync(join(root, "scripts"));
    writeFileSync(
      join(root, BASELINE),
      JSON.stringify({ "a.ts": { lines: 401, why: " one job " }, "b.ts": 402 }),
    );
    expect(exceptionsAt(root)).toEqual({
      "a.ts": { lines: 401, why: "one job" },
      "b.ts": { lines: 0, why: "" },
    });
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

  test("ignored files and folders named .ts aren't counted", () => {
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    put("packages/connectors/src/neon/dist/generated.d.ts", LIMIT + 1);
    mkdirSync(join(root, "packages/core/src/fixtures.ts"), { recursive: true });
    put("packages/core/src/fixtures.ts/inner.ts", 3);
    expect(problems(root, {})).toEqual([]);
    expect(sizes(root)).toEqual({ "packages/core/src/fixtures.ts/inner.ts": 3 });
  });
});
