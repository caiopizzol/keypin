import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  buildStatus,
  formatReference,
  loadRegistry,
  loadRotations,
  loadState,
  type MapResult,
  parseMap,
  type Problem,
  type Status,
  type StatusRow,
  type VaultMetadata,
} from "@keypin/core";
import { type Deps, localDay, UsageError } from "../deps";
import { registryPath, rotationsPath, statePath } from "../paths";
import { MAP_FILE } from "../project";
import { messageOf } from "../errors";
import { announce, distinctRefs, refKey } from "../vault";

export async function status(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  if (positionals.length) throw new UsageError("keypin status takes no arguments");

  const registry = await loadRegistry(deps.files, registryPath(deps));
  const state = await loadState(deps.files, statePath(deps));
  const { rotations } = await loadRotations(deps.files, rotationsPath(deps));
  const maps = new Map<string, MapResult>();
  for (const project of registry.projects) {
    const file = join(project, MAP_FILE);
    try {
      const text = await deps.files.read(file);
      if (text !== null) maps.set(project, parseMap(text, file));
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
    announce(deps.stderr, "rotated dates (no values)", refs);
    const vault = deps.vault();
    for (const ref of refs) {
      try {
        metadata.set(refKey(ref), await vault.metadata(ref));
      } catch (error) {
        deps.stderr.write(`keypin: ${messageOf(error)}\n`);
        metadata.set(refKey(ref), null);
      }
    }
  }

  const result = buildStatus({
    registry,
    maps,
    receipts: state.receipts,
    rotations,
    metadata: (ref) => metadata.get(refKey(ref)) ?? null,
    today: localDay(deps.now()),
  });

  if (values.json) {
    deps.stdout.write(`${JSON.stringify({ today: localDay(deps.now()), ...result }, null, 2)}\n`);
  } else {
    deps.stdout.write(render(result, registry.projects.length));
  }
  return result.problems.some((p) => p.severity === "problem") ? 1 : 0;
}

function render(result: Status, projects: number): string {
  if (!projects) return `No projects registered. Run "keypin init" in a project folder.\n`;
  const lines: string[] = [];
  const header = ["KEY", "ENV", "FROM", "ROTATED", "EVERY", "DUE"];
  const cells = (row: StatusRow) => [
    row.keyId,
    row.environment,
    formatReference(row.ref),
    row.rotated ?? "-",
    row.rotateEvery ?? "-",
    row.due ?? (row.rotateEvery === "never" ? "never" : "unknown"),
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...result.rows.map((r) => (cells(r)[i] ?? "").length)),
  );
  const line = (values: string[]) =>
    values
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();

  lines.push(line(header));
  let project: string | undefined;
  for (const row of result.rows) {
    if (row.project !== project) {
      project = row.project;
      lines.push(`# ${project}`);
    }
    lines.push(line(cells(row)));
    for (const d of row.destinations) {
      const receipt = d.receipt
        ? `last published ${d.receipt.at} by ${d.receipt.publisher}, generation ${d.receipt.generation}`
        : "no receipt";
      lines.push(`    -> ${d.destinationId} (account ${d.account}): ${receipt}`);
    }
  }
  if (!result.rows.length) lines.push("(no keys)");

  for (const [severity, title] of [
    ["problem", "Problems"],
    ["notice", "Notices"],
  ] as const) {
    const found = shown(result.problems.filter((p) => p.severity === severity));
    if (!found.length) continue;
    lines.push("", `${title} (${found.length}):`);
    for (const p of found) lines.push(`  ${p.kind}: ${p.message.replaceAll("\n", "\n    ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function shown(problems: Problem[]): Pick<Problem, "kind" | "message">[] {
  const unknown = problems.filter((p) => p.kind === "authority-unknown");
  const rest = problems.filter((p) => p.kind !== "authority-unknown");
  if (!unknown.length) return rest;
  const keys = [...new Set(unknown.map((p) => p.keyId ?? p.project))];
  const subject = keys.length === 1 ? "1 key" : `${keys.length} keys`;
  return [
    ...rest,
    {
      kind: "authority-unknown",
      message: `${subject} (${keys.join(", ")}): what each grants is unknown, because keypin didn't create it`,
    },
  ];
}
