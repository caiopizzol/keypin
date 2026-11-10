export const MIN_BUN = "1.4.4";

export function runtimeProblem(bun: string | undefined): string | null {
  if (bun === undefined) return `keypin runs on Bun ${MIN_BUN} or newer, not Node.`;
  if (olderThan(bun, MIN_BUN)) {
    return `keypin needs Bun ${MIN_BUN} or newer, because older Bun can read a keypin.toml wrong, and this is Bun ${bun}. Run it with "bunx bun@${MIN_BUN} <path to keypin>/apps/cli/src/main.ts".`;
  }
  return null;
}

function olderThan(version: string, minimum: string): boolean {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map(Number);
  const a = parts(version);
  const b = parts(minimum);
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}
