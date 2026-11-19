export function maskCommands(
  env: Readonly<Record<string, string | undefined>>,
  values: readonly string[],
): string {
  if (env.GITHUB_ACTIONS !== "true") return "";
  const lines = new Set(values.flatMap((value) => value.split(/\r\n|\r|\n/)).map((l) => l.trim()));
  lines.delete("");
  return [...lines].map((line) => `::add-mask::${line.replaceAll("%", "%25")}\n`).join("");
}
