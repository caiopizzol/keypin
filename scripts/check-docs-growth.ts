export const FILES = ["README.md", "skills/keypin/SKILL.md"];
export const LIMIT = 5;

const lines = (text: string) =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export function grown(before: string, after: string): number {
  return lines(after) - lines(before);
}

export function reason(trailers: string): string | null {
  return (
    trailers
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? null
  );
}

function git(...args: string[]): string | null {
  const result = Bun.spawnSync(["git", ...args], { stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

export function check(root = "."): {
  base: string | null;
  problems: string[];
  override: string | null;
} {
  const target = `origin/${process.env.GITHUB_BASE_REF || "main"}`;
  const base = git("-C", root, "merge-base", "HEAD", target)?.trim() || null;
  if (base === null) return { base, problems: [], override: null };
  const problems = FILES.flatMap((file) => {
    const show = (commit: string) => git("-C", root, "show", `${commit}:${file}`) ?? "";
    const growth = grown(show(base), show("HEAD"));
    return growth > LIMIT ? [`${file} grew by ${growth} lines`] : [];
  });
  const trailers = git(
    "-C",
    root,
    "log",
    "--format=%(trailers:key=Docs-Growth,valueonly)",
    `${base}..HEAD`,
  );
  return { base, problems, override: reason(trailers ?? "") };
}

if (import.meta.main) {
  const { base, problems, override } = check();
  if (base === null && process.env.GITHUB_BASE_REF) {
    process.stderr.write(
      `Can't find origin/${process.env.GITHUB_BASE_REF}; check out with fetch-depth: 0.\n`,
    );
    process.exitCode = 1;
  } else if (problems.length > 0 && override === null) {
    process.stderr.write(
      `${problems.join("\n")} (limit ${LIMIT} per PR).\nAGENTS.md: when you add a line, remove one; move details to docs/ or leave them to the error message. If the growth is needed, add a "Docs-Growth: <reason>" trailer to a commit in this PR. See docs/development.md#guardrails.\n`,
    );
    process.exitCode = 1;
  }
}
