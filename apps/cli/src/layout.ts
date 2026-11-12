import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
export type Target = (typeof TARGETS)[number];

export function isTarget(name: string): name is Target {
  return TARGETS.some((target) => target === name);
}

export function hostTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): Target | null {
  const name = `${platform}-${arch}`;
  return isTarget(name) ? name : null;
}

export function platformPackage(target: Target): string {
  return `@keypin/cli-${target}`;
}

export function launcherHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface Launcher {
  hash: string;
  target: Target;
  read(path: string): string | null;
  exists(path: string): boolean;
}

export function launchedBinary(path: string, launcher: Launcher): string | null {
  const text = launcher.read(path);
  if (text === null || launcherHash(text) !== launcher.hash) return null;
  const keypin = dirname(dirname(path));
  const binary = join(platformPackage(launcher.target), "bin", "keypin");
  return (
    [join(keypin, "node_modules", binary), join(keypin, "..", binary)].find((candidate) =>
      launcher.exists(candidate),
    ) ?? null
  );
}
