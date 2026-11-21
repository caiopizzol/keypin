import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Counts } from "./baseline";

export const LIMIT = 400;
export const BASELINE = "scripts/file-sizes.json";
const HOW = `Split it into a folder with one file per job, like apps/cli/src/commands/rotate/. If it is one job that doesn't split cleanly, add it to ${BASELINE} with its line count and why. See docs/development.md#guardrails.`;

export interface Exception {
  readonly lines: number;
  readonly why: string;
}
export type Exceptions = Record<string, Exception>;

function field(entry: unknown, key: string): unknown {
  if (typeof entry !== "object" || entry === null) return undefined;
  return Object.entries(entry).find(([name]) => name === key)?.[1];
}

export function exceptionsAt(root: string): Exceptions {
  const parsed: unknown = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
  const found: Record<string, Exception> = {};
  if (typeof parsed === "object" && parsed !== null)
    for (const [path, entry] of Object.entries(parsed)) {
      const lines = field(entry, "lines");
      const why = field(entry, "why");
      found[path] = {
        lines: typeof lines === "number" ? lines : 0,
        why: typeof why === "string" ? why.trim() : "",
      };
    }
  return found;
}

export function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function sourceFiles(root: string): string[] {
  const listed = Bun.spawnSync(
    [
      "git",
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
    ].concat(["apps", "packages"].map((group) => `:(glob)${group}/*/src/**/*.ts`)),
  );
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed in ${root}: ${listed.stderr.toString()}`);
  return listed.stdout
    .toString()
    .split("\0")
    .filter(
      (path) => path !== "" && existsSync(join(root, path)) && statSync(join(root, path)).isFile(),
    );
}

export function sizes(root: string): Counts {
  const found: Counts = {};
  for (const path of sourceFiles(root))
    found[path] = lineCount(readFileSync(join(root, path), "utf8"));
  return found;
}

export function problems(root: string, exceptions: Exceptions): string[] {
  const found: string[] = [];
  const current = sizes(root);
  for (const path of [...new Set([...Object.keys(current), ...Object.keys(exceptions)])].sort()) {
    const now = current[path] ?? 0;
    const listed = exceptions[path];
    if (listed === undefined) {
      if (now > LIMIT) found.push(`${path}: ${now} lines, more than ${LIMIT}. ${HOW}`);
    } else if (now <= LIMIT)
      found.push(`${path}: ${LIMIT} lines or fewer now. Remove its entry from ${BASELINE}.`);
    else {
      if (listed.why === "")
        found.push(
          `${path}: its entry in ${BASELINE} has no "why". Say why it stays one file, or split it.`,
        );
      if (now !== listed.lines)
        found.push(
          `${path}: ${now} lines now, not the ${listed.lines} in ${BASELINE}. Set "lines" to ${now}.`,
        );
    }
  }
  return found;
}

if (import.meta.main) {
  const found = problems(".", exceptionsAt("."));
  if (found.length > 0) {
    process.stderr.write(
      `A source file has at most ${LIMIT} lines, unless ${BASELINE} lists it with its size and why.\n${found.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
