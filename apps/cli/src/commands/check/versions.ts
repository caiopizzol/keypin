import type { KeypinPin } from "@keypin/core";

export function versionNotes(pins: readonly KeypinPin[], running: string): string[] {
  const files = new Map<string, string[]>();
  for (const { file, version } of pins)
    if (version !== running && !files.get(version)?.includes(file))
      files.set(version, [...(files.get(version) ?? []), file]);
  return [...files].map(([version, paths]) => {
    const where = `${paths.join(", ")} ${paths.length === 1 ? "installs" : "install"} keypin ${version}, and this is keypin ${running}`;
    return newer(version, running)
      ? `${where}; update this one: npm install -g keypin@${version}`
      : `${where}; change keypin@${version} to keypin@${running} there`;
  });
}

function newer(a: string, b: string): boolean {
  const [coreA = "", preA] = a.split(/-(.*)/s);
  const [coreB = "", preB] = b.split(/-(.*)/s);
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if ((partsA[i] ?? 0) !== (partsB[i] ?? 0)) return (partsA[i] ?? 0) > (partsB[i] ?? 0);
  if (preA === undefined || preB === undefined) return preA === undefined && preB !== undefined;
  return preA > preB;
}
