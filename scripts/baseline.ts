import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Counts = Record<string, number>;

function parse(text: string): Counts {
  const parsed: unknown = JSON.parse(text);
  const counts: Counts = {};
  if (typeof parsed === "object" && parsed !== null)
    for (const [path, n] of Object.entries(parsed)) if (typeof n === "number") counts[path] = n;
  return counts;
}

export function baselineAt(root: string, file: string): Counts {
  return parse(readFileSync(join(root, file), "utf8"));
}

const sum = (counts: Counts) => Object.values(counts).reduce((total, n) => total + n, 0);

export function raisedTotal(before: Counts | null, after: Counts, file: string): string[] {
  if (before === null || sum(after) <= sum(before)) return [];
  return [`${file} raises the total to ${sum(after)}, from ${sum(before)}.`];
}

function git(...args: string[]): string | null {
  const result = Bun.spawnSync(["git", ...args], { stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

export function raisedSinceBase(root: string, file: string): string[] {
  const target = `origin/${process.env.GITHUB_BASE_REF || "main"}`;
  const base = git("-C", root, "merge-base", "HEAD", target)?.trim() || null;
  if (base === null && process.env.GITHUB_BASE_REF) {
    process.stderr.write(`Can't find ${target}; check out with fetch-depth: 0.\n`);
    process.exitCode = 1;
    return [];
  }
  const text = base === null ? null : git("-C", root, "show", `${base}:${file}`);
  return raisedTotal(text === null ? null : parse(text), baselineAt(root, file), file);
}
