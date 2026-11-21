import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { baselineAt, type Counts, raisedSinceBase } from "./baseline";

export const LIMIT = 400;
export const BASELINE = "scripts/file-sizes.json";
const HOW = `Split it into a folder with one file per job, like apps/cli/src/commands/rotate/. See docs/development.md#guardrails.`;

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

export function problems(root: string, baseline: Counts): string[] {
  const found: string[] = [];
  const current = sizes(root);
  for (const path of [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort()) {
    const now = current[path] ?? 0;
    const allowed = baseline[path];
    if (allowed === undefined) {
      if (now > LIMIT) found.push(`${path}: ${now} lines, more than ${LIMIT}. ${HOW}`);
    } else if (now <= LIMIT)
      found.push(`${path}: ${LIMIT} lines or fewer now. Remove its entry from ${BASELINE}.`);
    else if (now > allowed)
      found.push(`${path}: ${now} lines, more than the ${allowed} in ${BASELINE}. ${HOW}`);
    else if (now < allowed)
      found.push(
        `${path}: ${now} lines now, fewer than the ${allowed} in ${BASELINE}. Lower it to ${now} so it stays there.`,
      );
  }
  return found;
}

if (import.meta.main) {
  const up = raisedSinceBase(".", BASELINE);
  if (up.length > 0) {
    process.stderr.write(
      `The sizes in ${BASELINE} only go down, so a change can't raise them.\n${up.join("\n")}\n${HOW}\n`,
    );
    process.exitCode = 1;
  }
  const found = problems(".", baselineAt(".", BASELINE));
  if (found.length > 0) {
    process.stderr.write(
      `A source file has at most ${LIMIT} lines; the files listed in ${BASELINE} only shrink.\n${found.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
