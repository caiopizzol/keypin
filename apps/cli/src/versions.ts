import type { KeypinPin } from "@keypin/core";

export function versionNotes(pins: readonly KeypinPin[], running: string): string[] {
  const files = new Map<string, string[]>();
  for (const { file, version } of pins)
    if (version !== running && !files.get(version)?.includes(file))
      files.set(version, [...(files.get(version) ?? []), file]);
  return [...files].map(([version, paths]) => {
    const where = `${paths.join(", ")} ${paths.length === 1 ? "installs" : "install"} keypin ${version}, and this is keypin ${running}`;
    const order = compare(version, running);
    if (order === null) return `${where}; make them the same version`;
    return order > 0
      ? `${where}; update this one: npm install -g keypin@${version}`
      : `${where}; change keypin@${version} to keypin@${running} there`;
  });
}

function compare(a: string, b: string): number | null {
  try {
    return Bun.semver.order(a, b);
  } catch {
    return null;
  }
}
