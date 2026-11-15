import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  buildStatus,
  type DestinationKinds,
  envFlag,
  kindOf,
  loadRegistry,
  loadState,
  type MapResult,
  parseMap,
  publishEnvironment,
  type Status,
  type StatusRow,
  targetOf,
  type VaultMetadata,
  vaultAccounts,
} from "@keypin/core";
import { type Deps, localDay, UsageError } from "../deps";
import { registryPath, statePath } from "../paths";
import { MAP_FILE } from "../project";
import { messageOf } from "../errors";
import { columns, type Output, output, tilde } from "../output";
import { approval } from "../sign-in";
import { distinctRefs, refKey } from "../vault";

type Problem = Status["problems"][number];

export async function status(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  if (positionals.length) throw new UsageError("keypin status takes no arguments");

  const registry = await loadRegistry(deps.files, registryPath(deps));
  const state = await loadState(deps.files, statePath(deps), deps.vaults);
  const maps = new Map<string, MapResult>();
  for (const project of registry.projects) {
    const file = join(project, MAP_FILE);
    try {
      const text = await deps.files.read(file);
      if (text !== null)
        maps.set(project, parseMap(text, file, deps.destinations, deps.issuers, deps.vaults));
    } catch (error) {
      deps.stderr.write(`keypin: couldn't read ${file}: ${messageOf(error)}\n`);
    }
  }

  const refs = distinctRefs(
    [...maps.values()].flatMap((result) =>
      result.ok
        ? result.map.keys.flatMap((key) =>
            Object.values(key.environments).flatMap((e) => (e ? [e.ref] : [])),
          )
        : [],
    ),
  );
  const metadata = new Map<string, VaultMetadata | null>();
  if (refs.length) {
    const errors: string[] = [];
    const dates = count(refs.length, "rotated date");
    const from = `from ${vaultAccounts(refs, deps.vaults)}, not the values`;
    await output(deps.stderr, deps.styled.stderr, deps.columns).step(
      `Reading ${dates}`,
      async () => {
        const vault = deps.vault();
        for (const ref of refs) {
          try {
            metadata.set(refKey(ref), await vault.metadata(ref));
          } catch (error) {
            errors.push(messageOf(error));
            metadata.set(refKey(ref), null);
          }
        }
      },
      () => ({
        ok: !errors.length,
        text: errors.length
          ? `Couldn't read ${errors.length} of ${dates} ${from}`
          : `Read ${dates} ${from}`,
      }),
      approval(deps, refs),
    );
    for (const error of new Set(errors)) deps.stderr.write(`keypin: ${error}\n`);
  }

  const today = localDay(deps.now());
  const result = buildStatus({
    kinds: deps.destinations,
    vaults: deps.vaults,
    registry,
    maps,
    receipts: state.receipts,
    metadata: (ref) => metadata.get(refKey(ref)) ?? null,
    today,
  });

  if (values.json) {
    deps.stdout.write(`${JSON.stringify({ today, ...result }, null, 2)}\n`);
  } else {
    const command = (name: string) => (row: StatusRow) => {
      const map = maps.get(row.project);
      const fallback = map?.ok ? publishEnvironment(map.map) : row.environment;
      return `keypin ${name} ${row.keyId}${envFlag(row.environment, fallback)}`;
    };
    const out = output(deps.stdout, deps.styled.stdout);
    deps.stdout.write(
      render(result, registry.projects, {
        today,
        home: deps.home,
        kinds: deps.destinations,
        out,
        publish: command("publish"),
        rotate: command("rotate"),
        rotates: (row) => row.issuer !== null && row.destinations.length > 0,
      }),
    );
  }
  return result.problems.some((p) => p.severity === "problem") ? 1 : 0;
}

interface Context {
  today: string;
  home: string;
  kinds: DestinationKinds;
  out: Output;
  publish: (row: StatusRow) => string;
  rotate: (row: StatusRow) => string;
  rotates: (row: StatusRow) => boolean;
}

function render(result: Status, projects: readonly string[], context: Context): string {
  if (!projects.length) return `No projects registered. Run "keypin init" in a project folder.\n`;
  const { home, out } = context;
  const cells = columns(
    result.rows.map((row) => [
      row.keyId,
      row.environment,
      due(row, context),
      ...places(row, result.problems, context),
    ]),
  );

  const lines: string[] = [];
  for (const project of projects) {
    lines.push(`${out.bold(basename(project))} ${out.dim(tilde(project, home))}`);
    result.rows.forEach((row, i) => {
      if (row.project === project) lines.push(`  ${(cells[i] ?? []).join("  ")}`.trimEnd());
    });
  }

  for (const severity of ["problem", "notice"] as const) {
    const found = result.problems.filter((p) => p.severity === severity);
    if (!found.length) continue;
    const title = count(found.length, severity);
    lines.push("", severity === "problem" ? out.red(title) : out.bold(title));
    for (const p of found) {
      const where = p.keyId === undefined ? "" : `${out.dim(basename(p.project))} `;
      lines.push(
        `  ${where}${tilde(message(p, result, context), home).replaceAll("\n", "\n    ")}`,
      );
      const next = nextStep(p, result.rows, context);
      if (next) lines.push(`    ${tilde(next, home)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function message(problem: Problem, result: Status, context: Context): string {
  const row = result.rows.find((r) => sameRow(problem, r));
  if (problem.kind !== "never-published" || !row) return problem.message;
  const unknown = (id: string) =>
    result.problems.some(
      (p) => p.kind === "missing-receipt" && sameRow(p, row) && p.destinationId === id,
    );
  const names = row.destinations
    .filter(({ destinationId, receipt }) => !receipt && !unknown(destinationId))
    .map(({ destinationId, account }) => placeName(destinationId, account, context.kinds));
  return `${row.keyId} (${row.environment}): not published yet to ${names.join(", ")}; run ${context.publish(row)}`;
}

function placeName(id: string, account: string, kinds: DestinationKinds): string {
  const found = targetOf(id, account, kinds);
  return found ? found.kind.named(found.target) : id;
}

function due(row: StatusRow, { out, today }: Context): string {
  if (row.rotateEvery === "never") return out.dim("never rotates");
  if (row.due === null) return out.red("rotation unknown");
  const days = daysBetween(today, row.due);
  if (days < 0) return out.red(`${count(-days, "day")} overdue`);
  return days === 0 ? "due today" : `due in ${count(days, "day")}`;
}

function places(row: StatusRow, problems: readonly Problem[], context: Context): string[] {
  const { out, kinds } = context;
  const service = (id: string) => kindOf(kinds, id.split(":")[0] ?? "").label;
  return row.destinations.map(({ destinationId: id, receipt }) => {
    const shared = row.destinations.filter((d) => service(d.destinationId) === service(id));
    const name =
      shared.length > 1 ? `${service(id)} ${id.split(":").slice(1, -1).join(":")}` : service(id);
    if (receipt) return `${out.mark(true).trimEnd()} ${name}`;
    const unknown = problems.some(
      (p) => p.kind === "missing-receipt" && sameRow(p, row) && p.destinationId === id,
    );
    return `${out.dim("·")} ${name} ${out.dim(unknown ? "no receipt" : "not published")}`;
  });
}

function nextStep(problem: Problem, rows: readonly StatusRow[], context: Context): string | null {
  const row = rows.find((r) => sameRow(problem, r));
  if (!row) return null;
  const infisical = row.ref.kind === "infisical";
  if (problem.kind === "overdue" || problem.kind === "due-soon") {
    if (context.rotates(row)) return `Run ${context.rotate(row)} in ${row.project}.`;
    const rotate = infisical
      ? "Put a new value in the Infisical secret and set its rotated metadata to today"
      : "Put a new value in the 1Password item and set rotated to today";
    return row.destinations.length
      ? `${rotate}, then run ${context.publish(row)} in ${row.project}.`
      : `${rotate}.`;
  }
  if (problem.kind === "no-rotation-date" && row.rotated === null)
    return infisical
      ? "Add rotated to the Infisical secret's metadata, with the day the value last changed as YYYY-MM-DD."
      : "Add a rotated Date field to the 1Password item, with the day the value last changed.";
  return null;
}

function sameRow(problem: Problem, row: StatusRow): boolean {
  return (
    problem.project === row.project &&
    problem.keyId === row.keyId &&
    problem.environment === row.environment
  );
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
