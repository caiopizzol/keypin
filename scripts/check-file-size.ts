import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baselineAt, type Counts, raisedSinceBase } from "./baseline";

export const LIMIT = 400;
export const BASELINE = "scripts/file-sizes.json";
const HOW = `Split it into a folder with one file per job, like apps/cli/src/commands/rotate/. See docs/development.md#guardrails.`;

export function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function sizes(root: string): Counts {
  const found: Counts = {};
  for (const group of ["apps", "packages"]) {
    if (!existsSync(join(root, group))) continue;
    for (const name of readdirSync(join(root, group))) {
      const src = `${group}/${name}/src`;
      if (!existsSync(join(root, src))) continue;
      for (const file of readdirSync(join(root, src), { recursive: true, encoding: "utf8" })) {
        const path = `${src}/${file.replaceAll("\\", "/")}`;
        if (path.endsWith(".ts")) found[path] = lineCount(readFileSync(join(root, path), "utf8"));
      }
    }
  }
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
