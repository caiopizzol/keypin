import { readdirSync, readFileSync } from "node:fs";

const DIR = ".github/workflows";
const SKIPPED = new Set(["pullfrog.yml"]);
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function unpinned(text: string): string[] {
  const workflow: unknown = Bun.YAML.parse(text);
  const jobs = isRecord(workflow) && isRecord(workflow.jobs) ? Object.values(workflow.jobs) : [];
  return jobs
    .filter(isRecord)
    .flatMap((job) => [
      job.uses,
      ...(Array.isArray(job.steps) ? job.steps.filter(isRecord).map((step) => step.uses) : []),
    ])
    .filter((uses) => uses !== undefined)
    .map(String)
    .filter((uses) => !uses.startsWith("./") && !PINNED.test(uses));
}

function problems(name: string): string[] {
  const path = `${DIR}/${name}`;
  try {
    return unpinned(readFileSync(path, "utf8")).map((uses) => `${path}: ${uses}`);
  } catch {
    return [`${path}: not valid YAML`];
  }
}

if (import.meta.main) {
  const found = readdirSync(DIR)
    .filter((name) => /\.ya?ml$/.test(name) && !SKIPPED.has(name))
    .flatMap(problems);
  if (found.length > 0) {
    process.stderr.write(
      `Pin each action to a full commit SHA, with its version in a comment: uses: owner/action@<40-char sha> # v1.2.3\n${found.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
