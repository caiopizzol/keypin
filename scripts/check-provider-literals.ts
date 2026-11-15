import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHARED = ["packages/core/src", "apps/cli/src"];
const COMPOSITION = new Set(["apps/cli/src/start.ts", "apps/cli/src/sign-in.ts"]);
const MENTION =
  /1password|onepassword|infisical|github|cloudflare|wrangler|resend|neon|op:\/\/|\bgh\b/gi;
export const BASELINE = "scripts/provider-literals.json";
const HOW = `Move the text into the provider's kind in packages/connectors (DestinationKind, IssuerKind or VaultKind). See docs/development.md#guardrails.`;

export function mentions(text: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const [match] of text.matchAll(MENTION)) {
    const word = match.toLowerCase();
    found[word] = (found[word] ?? 0) + 1;
  }
  return found;
}

const total = (found: Record<string, number>) =>
  Object.values(found).reduce((sum, n) => sum + n, 0);

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

const words = (found: Record<string, number>) =>
  Object.entries(found)
    .map(([word, n]) => `${word} ×${n}`)
    .join(", ");

export function counts(root: string): Record<string, Record<string, number>> {
  const found: Record<string, Record<string, number>> = {};
  for (const dir of SHARED) {
    if (!existsSync(join(root, dir))) continue;
    for (const file of readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })) {
      const path = `${dir}/${file.replaceAll("\\", "/")}`;
      if (!path.endsWith(".ts") || COMPOSITION.has(path)) continue;
      const each = mentions(readFileSync(join(root, path), "utf8"));
      if (total(each) > 0) found[path] = each;
    }
  }
  return found;
}

export function problems(root: string, baseline: Record<string, number>): string[] {
  const found: string[] = [];
  const current = counts(root);
  for (const path of [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort()) {
    const each = current[path] ?? {};
    const now = total(each);
    const allowed = baseline[path] ?? 0;
    if (now > allowed && allowed === 0)
      found.push(`${path}: names a provider ${times(now)} (${words(each)}). ${HOW}`);
    else if (now > allowed)
      found.push(
        `${path}: names a provider ${times(now)} (${words(each)}), more than the ${allowed} in ${BASELINE}. ${HOW}`,
      );
    else if (now < allowed)
      found.push(
        now === 0
          ? `${path}: names no provider now. Remove its entry from ${BASELINE} so it stays at zero.`
          : `${path}: names a provider ${times(now)} now (${words(each)}), fewer than the ${allowed} in ${BASELINE}. Lower it to ${now} so it stays there.`,
      );
  }
  return found;
}

function parse(text: string): Record<string, number> {
  const parsed: unknown = JSON.parse(text);
  const baseline: Record<string, number> = {};
  if (typeof parsed === "object" && parsed !== null)
    for (const [path, n] of Object.entries(parsed)) if (typeof n === "number") baseline[path] = n;
  return baseline;
}

export function baselineAt(root: string): Record<string, number> {
  return parse(readFileSync(join(root, BASELINE), "utf8"));
}

export function raised(
  before: Record<string, number> | null,
  after: Record<string, number>,
): string[] {
  if (before === null) return [];
  return Object.entries(after)
    .filter(([path, n]) => n > (before[path] ?? 0))
    .map(([path, n]) => `${path}: ${BASELINE} raises it to ${n}, from ${before[path] ?? 0}.`);
}

function git(...args: string[]): string | null {
  const result = Bun.spawnSync(["git", ...args], { stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

function baselineAtBase(root: string): {
  base: string | null;
  before: Record<string, number> | null;
} {
  const target = `origin/${process.env.GITHUB_BASE_REF || "main"}`;
  const base = git("-C", root, "merge-base", "HEAD", target)?.trim() || null;
  const text = base === null ? null : git("-C", root, "show", `${base}:${BASELINE}`);
  return { base, before: text === null ? null : parse(text) };
}

if (import.meta.main) {
  const { base, before } = baselineAtBase(".");
  if (base === null && process.env.GITHUB_BASE_REF) {
    process.stderr.write(
      `Can't find origin/${process.env.GITHUB_BASE_REF}; check out with fetch-depth: 0.\n`,
    );
    process.exitCode = 1;
  }
  const up = raised(before, baselineAt("."));
  if (up.length > 0) {
    process.stderr.write(
      `The counts in ${BASELINE} only go down, so a change can't raise them.\n${up.join("\n")}\n${HOW}\n`,
    );
    process.exitCode = 1;
  }
  const found = problems(".", baselineAt("."));
  if (found.length > 0) {
    process.stderr.write(
      `Core and the CLI outside start.ts and sign-in.ts name no provider; the counts in ${BASELINE} only go down.\n${found.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
