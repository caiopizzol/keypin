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

export const LAUNCHER_MAX_BYTES = 16 * 1024;

export function launchOrder(target: Target): Target[] {
  switch (target) {
    case "darwin-arm64":
      return ["darwin-arm64", "darwin-x64"];
    case "darwin-x64":
      return ["darwin-x64", "darwin-arm64"];
    case "linux-x64":
    case "linux-arm64":
      return [target];
  }
}

export interface Launcher {
  hash: string;
  target: Target;
  size(path: string): number | null;
  read(path: string): string | null;
  exists(path: string): boolean;
}

export function launchedBinary(path: string, launcher: Launcher): string | null {
  const keypin = dirname(dirname(path));
  const found = launchOrder(launcher.target)
    .map((target) => join(platformPackage(target), "bin", "keypin"))
    .flatMap((binary) => [join(keypin, "node_modules", binary), join(keypin, "..", binary)])
    .find((candidate) => launcher.exists(candidate));
  if (found === undefined) return null;
  const size = launcher.size(path);
  if (size === null || size > LAUNCHER_MAX_BYTES) return null;
  const text = launcher.read(path);
  return text !== null && launcherHash(text) === launcher.hash ? found : null;
}
