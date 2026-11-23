import { basename } from "node:path";
import { count, type Output, tilde } from "../../output";
import { type Report, ITEM_NOTE } from "./report";
import { type Step } from "./steps";

export const THEN = "Then run keypin check again.";

export function render(
  report: Report,
  read: string,
  steps: Step[],
  out: Output,
  home: string,
): string {
  const { bold, dim, mark } = out;
  const { notScanned } = report.read;
  const lines = [`${bold(basename(report.folder))} ${dim(`${report.folder} · ${read}`)}`];
  if (notScanned.length)
    lines.push(dim(`Not scanned (own git repository): ${notScanned.join(", ")}`));
  if (steps.length) {
    lines.push(
      steps.length === 1 ? "1 thing to do:" : `${steps.length} things to do, in this order:`,
    );
    const last = steps.findLastIndex((step) => step.toml !== undefined);
    steps.forEach((step, i) => {
      lines.push(bold(`${i + 1} ${step.title}`), ...step.body.map((line) => `  ${line}`));
      if (step.toml !== undefined) lines.push("", step.toml.trimEnd(), "");
      if (i === last) lines.push(`  ${THEN}`);
    });
  } else {
    const keys = new Set(report.keys.map((row) => row.key)).size;
    const destinations = report.keys.reduce((n, row) => n + row.destinations.length, 0);
    lines.push(
      `${mark(true)} ${count(keys, "key")}, ${count(destinations, "destination")}. Everything checks out.`,
    );
  }
  const shown = new Set(steps.flatMap((step) => step.covers));
  for (const u of report.unknown) lines.push(dim(`Not checked: ${u.what}; ${u.reason}`));
  for (const note of report.notes)
    if (note !== ITEM_NOTE && !shown.has(note)) lines.push(dim(`Note: ${note}`));
  return tilde(`${lines.join("\n")}\n`, home);
}
