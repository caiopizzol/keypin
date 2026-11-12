import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type Environment,
  findGaps,
  formatReference,
  type Gaps,
  type KeyRef,
  type KeysMap,
  loadRegistry,
  parseMap,
  type PublishTarget,
  secretKey,
} from "@keypin/core";
import { type Deps, UsageError } from "../deps";
import { messageOf } from "../errors";
import { registryPath } from "../paths";
import { locateMap, MAP_FILE } from "../project";
import { describeLogin, publisherFor } from "../publisher";
import { type ScanResult, scanProject, type Unknown } from "../scan";
import { announce, distinctRefs, refKey } from "../vault";

interface ItemResult {
  reference: string;
  ok: boolean;
  problem: string | null;
}

interface DestinationResult {
  destination: string;
  to: PublishTarget["to"];
  login: string;
  publisher: string | null;
  pinned: string;
  reached: string | null;
  ok: boolean;
  problem: string | null;
  fix: string | null;
}

interface KeyResult {
  key: string;
  environment: Environment;
  from: ItemResult;
  destinations: DestinationResult[];
}

interface Report {
  folder: string;
  map: string | null;
  registered: boolean;
  read: ScanResult["files"] & { notScanned: string[] };
  github: { repo: string | null; login: string | null };
  keys: KeyResult[];
  production: Gaps["production"];
  local: Gaps["local"];
  add: string | null;
  unknown: Unknown[];
  notes: string[];
  problems: string[];
  ok: boolean;
}

export async function check(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new UsageError("keypin check takes at most one folder");
  const folder = resolve(deps.cwd, positionals[0] ?? ".");
  if (!(await deps.isFolder(folder))) throw new Error(`${folder} isn't a folder`);

  const report = await build(folder, deps);
  deps.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
  return report.ok ? 0 : 1;
}

async function build(folder: string, deps: Deps): Promise<Report> {
  const found = await locateMap(deps.files, folder);
  const root = found ? dirname(found.file) : folder;
  const scanned = await scanProject(deps, root);
  const report: Report = {
    folder: root,
    map: found?.file ?? null,
    registered: false,
    read: { ...scanned.files, notScanned: scanned.nested },
    github: { repo: scanned.scan.github.repo, login: scanned.login },
    keys: [],
    production: [],
    local: [],
    add: null,
    unknown: scanned.unknowns,
    notes: [],
    problems: [],
    ok: false,
  };
  const gaps = (map: KeysMap | null) => {
    const result = findGaps(scanned.scan, map && found ? { map, text: found.text } : null);
    report.production = result.production;
    report.local = result.local;
    report.add = result.add;
    report.problems.push(...result.problems);
    report.notes.push(...result.notes);
  };
  if (!found) {
    report.problems.push(
      `no ${MAP_FILE} in ${folder} or any folder above it; run keypin init, then keypin check again`,
    );
    gaps(null);
    return finish(report);
  }
  const registry = await loadRegistry(deps.files, registryPath(deps));
  report.registered = registry.projects.includes(root);
  if (!report.registered)
    report.notes.push(
      `${root} isn't registered, so keypin status doesn't list it; run keypin init there`,
    );

  const parsed = parseMap(found.text, found.file);
  if (!parsed.ok) {
    report.problems.push(...parsed.errors);
    return finish(report);
  }
  const map = parsed.map;
  if (!map.keys.length) {
    report.problems.push(
      `${found.file} maps no keys yet; run keypin import for an env file, and add the TOML below for production`,
    );
    gaps(map);
    return finish(report);
  }

  const entries = map.keys.flatMap((key) =>
    map.environments.flatMap((environment) => {
      const entry = key.environments[environment];
      return entry ? [{ key: key.name, environment, entry }] : [];
    }),
  );
  const users = new Map<string, string[]>();
  const use = (id: string, label: string) => users.set(id, [...(users.get(id) ?? []), label]);

  const refs = distinctRefs(entries.map(({ entry }) => entry.ref));
  announce(deps.stderr, "the item IDs, not the values,", refs);
  report.notes.push(
    "items are looked up in each vault's item list, which holds no values, so no field is checked; keypin run and keypin publish --plan read the fields",
  );
  const items = new Map<string, ItemResult>();
  for (const ref of refs) items.set(refKey(ref), await checkItem(ref, deps));

  const targets = new Map<string, PublishTarget>();
  for (const { entry } of entries)
    for (const target of entry.publish) targets.set(placeOf(target), target);
  const publisher = {
    ...(await publisherFor([...targets.values()], deps, folder)),
    refreshLogins: false,
  };
  const wrangler = [...targets.values()].some((t) => t.to === "cloudflare-worker")
    ? await deps.wranglerLoginFile()
    : null;
  if (wrangler !== null)
    report.notes.push(
      `the wrangler login is an OAuth token stored in plain text in ${wrangler}; wrangler logout removes it`,
    );
  const destinations = new Map<string, DestinationResult>();
  for (const [place, target] of targets) {
    const login =
      target.to === "github-actions"
        ? describeLogin(publisher.githubLogin)
        : `the wrangler login${wrangler === null ? "" : ` in ${wrangler}`}`;
    destinations.set(place, await checkDestination(place, target, login, publisher, deps));
  }

  for (const { key, environment, entry } of entries) {
    const label = `${key} (${environment})`;
    const from = items.get(refKey(entry.ref));
    if (!from) throw new Error(`no item check for ${formatReference(entry.ref)}`);
    use(`item ${refKey(entry.ref)}`, label);
    const reached = entry.publish.map((target) => {
      use(`place ${placeOf(target)}`, label);
      const result = destinations.get(placeOf(target));
      if (!result) throw new Error(`no account check for ${placeOf(target)}`);
      return { ...result, destination: secretKey(target, key) };
    });
    report.keys.push({ key, environment, from, destinations: reached });
  }

  const usedBy = (id: string) => ` (${users.get(id)?.join(", ") ?? "unused"})`;
  for (const ref of refs) {
    const item = items.get(refKey(ref));
    if (item?.problem) report.problems.push(`${item.problem}${usedBy(`item ${refKey(ref)}`)}`);
  }
  for (const [place, result] of destinations) {
    if (result.ok) continue;
    const fix = result.fix ? `; fix: ${result.fix}` : "";
    report.problems.push(`${place}: ${result.problem}${fix}${usedBy(`place ${place}`)}`);
  }
  gaps(map);
  return finish(report);
}

function finish(report: Report): Report {
  report.ok = !report.problems.length;
  return report;
}

async function checkItem(ref: KeyRef, deps: Deps): Promise<ItemResult> {
  const reference = formatReference(ref);
  try {
    await deps.vault().itemIds(ref);
    return { reference, ok: true, problem: null };
  } catch (error) {
    return { reference, ok: false, problem: messageOf(error) };
  }
}

async function checkDestination(
  place: string,
  target: PublishTarget,
  login: string,
  publisher: Parameters<Deps["destination"]>[1],
  deps: Deps,
): Promise<DestinationResult> {
  const base = { destination: place, to: target.to, login, pinned: target.account };
  try {
    const result = await deps.destination(target, publisher).checkAccount();
    return {
      ...base,
      publisher: result.publisher,
      reached: result.destinationAccount,
      ok: result.ok,
      problem: result.ok ? null : (result.reason ?? "the account check failed"),
      fix: result.ok ? null : (result.fix ?? null),
    };
  } catch (error) {
    return {
      ...base,
      publisher: null,
      reached: null,
      ok: false,
      problem: messageOf(error),
      fix: null,
    };
  }
}

function placeOf(target: PublishTarget): string {
  return target.to === "cloudflare-worker"
    ? `cloudflare-worker:${target.account}/${target.worker}`
    : `github-actions:${target.repo.toLowerCase()}`;
}

function render(report: Report): string {
  const lines = [`keypin check ${report.map ?? report.folder}`];
  const { env, wrangler, workflows, notScanned } = report.read;
  lines.push(
    `  read: ${count(env.length, "env file")}, ${count(wrangler.length, "wrangler config")}, ${count(workflows.length, "workflow")}`,
  );
  if (report.github.repo) lines.push(`  GitHub: ${report.github.repo}`);
  if (notScanned.length) lines.push(`  not scanned (own git repository): ${notScanned.join(", ")}`);
  for (const row of report.keys) {
    lines.push("", `${row.key} (${row.environment})`);
    lines.push(`  ${mark(row.from.ok)} from ${row.from.reference}`);
    for (const d of row.destinations) {
      lines.push(
        `  ${mark(d.ok)} ${d.destination}: login ${d.login}, publisher ${d.publisher ?? "unknown"}, pinned account ${d.pinned}, reaches ${d.reached ?? "unknown"}`,
      );
    }
  }
  if (report.production.length) {
    lines.push("", "Production needs:");
    for (const need of report.production) {
      const holds = need.holds === null ? "unknown" : need.holds ? "has it" : "doesn't have it";
      const mapped = need.mapped === null ? "not in keypin.toml" : `keypin.toml (${need.mapped})`;
      lines.push(
        `  ${mark(need.ok)} ${need.name} in ${need.place} (${need.usedBy.join(", ")}): ${holds}, ${mapped}`,
      );
    }
  }
  const local = report.local.filter((file) => file.unmapped.length || file.elsewhere.length);
  if (local.length) {
    lines.push("", "Set in an env file, with no local entry in keypin.toml:");
    for (const file of local)
      lines.push(`  ${file.file}: ${[...file.unmapped, ...file.elsewhere].join(", ")}`);
  }
  if (report.unknown.length) {
    lines.push("", `Unknown (${report.unknown.length}):`);
    for (const u of report.unknown) lines.push(`  ${u.what}: ${u.reason}`);
  }
  if (report.notes.length) {
    lines.push("", `Notes (${report.notes.length}):`);
    for (const note of report.notes) lines.push(`  ${note}`);
  }
  if (report.problems.length) {
    lines.push("", `Problems (${report.problems.length}):`);
    for (const problem of report.problems) lines.push(`  ${problem}`);
  } else lines.push("", "Everything checks out.");
  if (report.add !== null) {
    lines.push(
      "",
      `Add to ${report.map ?? MAP_FILE}, then replace each <...> with the real value (keypin rejects a map that still has one):`,
      "",
      report.add.trimEnd(),
    );
  }
  return `${lines.join("\n")}\n`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function mark(ok: boolean): string {
  return ok ? "ok    " : "FAILED";
}
