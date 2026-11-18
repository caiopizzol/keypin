import { shellWord } from "../src/approval";

export interface Recorded {
  args: readonly string[];
  exit: number;
  stdout: string;
  stderr: string;
  files?: Record<string, string>;
  given?: Record<string, unknown>;
  calls?: Record<string, readonly string[]>;
  wrote?: Record<string, string | null>;
}

function section(title: string, body: string): string {
  return `--- ${title} ---\n${body === "" || body.endsWith("\n") ? body : `${body}\n`}`;
}

function output(title: string, body: string): string {
  const ending = body === "" || body.endsWith("\n") ? "" : "\n(no newline at end)\n";
  return `--- ${title} ---\n${body}${ending}`;
}

export function recording(run: Recorded): string {
  const parts = [`$ keypin ${run.args.map(shellWord).join(" ")}\nexit ${run.exit}\n`];
  for (const [path, text] of Object.entries(run.files ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    parts.push(section(`file ${path}`, text));
  for (const [name, value] of Object.entries(run.given ?? {}))
    if (value !== undefined) parts.push(section(`given ${name}`, JSON.stringify(value, null, 2)));
  for (const [name, calls] of Object.entries(run.calls ?? {}))
    parts.push(section(`calls ${name}`, calls.map((call) => `${call}\n`).join("")));
  parts.push(output("stdout", run.stdout), output("stderr", run.stderr));
  for (const [path, text] of Object.entries(run.wrote ?? {}))
    parts.push(output(text === null ? `deleted ${path}` : `wrote ${path}`, text ?? ""));
  return parts.join("\n");
}

export function changes(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): Record<string, string | null> {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return Object.fromEntries(
    [...paths]
      .filter((path) => before.get(path) !== after.get(path))
      .sort()
      .map((path) => [path, after.get(path) ?? null]),
  );
}
