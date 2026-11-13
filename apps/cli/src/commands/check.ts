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
import { columns, type Output, output, tilde } from "../output";
import { registryPath } from "../paths";
import { locateMap, MAP_FILE } from "../project";
import { labels } from "../publishing";
import { describeLogin, githubLogin, publisherFor } from "../publisher";
import { type ScanResult, scanProject, type Unknown, usesSecrets } from "../scan";
import { distinctRefs, refKey } from "../vault";

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

interface Prerequisite {
  name: "GitHub" | "Cloudflare" | "1Password";
  status: "not installed" | "not logged in" | "not checked" | "sign-in failed";
  fix: string;
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
  prerequisites: Prerequisite[];
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

  const { report, places } = await build(folder, deps);
  deps.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : render(report, places, output(deps.stdout, deps.styled.stdout), deps.home),
  );
  return report.ok ? 0 : 1;
}

type Places = Map<DestinationResult, string>;

async function build(folder: string, deps: Deps): Promise<{ report: Report; places: Places }> {
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  const places: Places = new Map();
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
    prerequisites: [],
    notes: [],
    problems: [],
    ok: false,
  };
  const targets = new Map<string, PublishTarget>();
  const items = new Map<string, ItemResult>();
  const done = async () => {
    report.prerequisites = await prerequisites(root, scanned, targets, items, deps);
    return { report: finish(report), places };
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
    return done();
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
    return done();
  }
  const map = parsed.map;
  if (!map.keys.length) {
    report.problems.push(
      `${found.file} maps no keys yet; run keypin import for an env file, and add the TOML below for production`,
    );
    gaps(map);
    return done();
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
  report.notes.push(
    "items are looked up in each vault's item list, which holds no values, so no field is checked; keypin run and keypin publish --plan read the fields",
  );
  const lookup = `${count(refs.length, "item")} in 1Password account ${[...new Set(refs.map((ref) => ref.account))].join(", ")}, not the values`;
  await out.step(
    `Looking up ${lookup}`,
    async () => {
      for (const ref of refs) items.set(refKey(ref), await checkItem(ref, deps));
    },
    () => ({
      ok: [...items.values()].every((item) => item.ok),
      text: `Looked up ${lookup}`,
    }),
    "1Password may be asking you to approve keypin",
  );

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
  const accounts = count(targets.size, "account");
  if (targets.size)
    await out.step(
      `Checking ${accounts}`,
      async () => {
        for (const [place, target] of targets) {
          const login =
            target.to === "github-actions"
              ? describeLogin(publisher.githubLogin)
              : `the wrangler login${wrangler === null ? "" : ` in ${wrangler}`}`;
          destinations.set(place, await checkDestination(place, target, login, publisher, deps));
        }
      },
      () => ({
        ok: [...destinations.values()].every((d) => d.ok),
        text: `Checked ${accounts}`,
      }),
    );
  const label = labels([...targets.values()]);

  for (const { key, environment, entry } of entries) {
    const name = `${key} (${environment})`;
    const from = items.get(refKey(entry.ref));
    if (!from) throw new Error(`no item check for ${formatReference(entry.ref)}`);
    use(`item ${refKey(entry.ref)}`, name);
    const reached = entry.publish.map((target) => {
      use(`place ${placeOf(target)}`, name);
      const result = destinations.get(placeOf(target));
      if (!result) throw new Error(`no account check for ${placeOf(target)}`);
      const row = { ...result, destination: secretKey(target, key) };
      places.set(row, label(target));
      return row;
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
  return done();
}

const INTEGRATION =
  "the 1Password desktop app, with Settings → Developer → Integrate with other apps selected";

async function prerequisites(
  root: string,
  scanned: ScanResult,
  targets: Map<string, PublishTarget>,
  items: Map<string, ItemResult>,
  deps: Deps,
): Promise<Prerequisite[]> {
  const list: Prerequisite[] = [];
  const to = (kind: PublishTarget["to"]) => [...targets.values()].some((t) => t.to === kind);
  if (usesSecrets(scanned.scan.workflows) || to("github-actions")) {
    const login = await githubLogin(deps, root);
    const status = await deps.ghLogin(login);
    const signIn = `gh auth login --hostname github.com${login ? `, signing in as ${login}` : ""}`;
    if (status === "not installed")
      list.push({
        name: "GitHub",
        status,
        fix: `install gh (https://cli.github.com), then run ${signIn}`,
      });
    else if (status === "not logged in")
      list.push({ name: "GitHub", status, fix: `run ${signIn}` });
  }
  if (
    (scanned.files.wrangler.length || to("cloudflare-worker")) &&
    !(await deps.wranglerLoginFile())
  )
    list.push({ name: "Cloudflare", status: "not logged in", fix: "run wrangler login" });
  if (!items.size)
    list.push({ name: "1Password", status: "not checked", fix: `keypin needs ${INTEGRATION}` });
  else if ([...items.values()].some((item) => item.problem?.includes("sign-in failed")))
    list.push({
      name: "1Password",
      status: "sign-in failed",
      fix: `check ${INTEGRATION}, and that it's unlocked`,
    });
  return list;
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
    : `github-actions:${target.repo.toLowerCase()}${target.environment === undefined ? "" : `/environments/${target.environment.toLowerCase()}`}`;
}

function render(report: Report, places: Places, out: Output, home: string): string {
  const { bold, dim, mark } = out;
  const lines = [bold(`keypin check ${report.map ?? report.folder}`)];
  const { env, wrangler, workflows, notScanned } = report.read;
  const read = `read ${count(env.length, "env file")}, ${count(wrangler.length, "wrangler config")}, ${count(workflows.length, "workflow")}`;
  lines.push(`  ${dim(report.github.repo ? `${read}; GitHub ${report.github.repo}` : read)}`);
  if (notScanned.length)
    lines.push(`  ${dim(`not scanned (own git repository): ${notScanned.join(", ")}`)}`);
  if (report.prerequisites.length) {
    lines.push("", bold("Before you start:"));
    const rows = columns(report.prerequisites.map((p) => [`${p.name}:`, `${p.status};`]));
    report.prerequisites.forEach((p, i) => lines.push(`  ${(rows[i] ?? []).join(" ")} ${p.fix}`));
  }
  for (const row of report.keys) {
    lines.push("", `${bold(row.key)} ${row.environment}`);
    lines.push(`  ${mark(row.from.ok)} ${row.from.reference}`);
    for (const d of row.destinations) {
      const facts = d.ok
        ? `as ${d.publisher ?? "unknown"}, account ${d.reached ?? d.pinned}`
        : `as ${d.publisher ?? "unknown"}, pinned ${d.pinned}, reaches ${d.reached ?? "unknown"}`;
      lines.push(
        `  ${mark(d.ok)} ${places.get(d) ?? d.destination}  ${dim(`${facts}; ${d.login}`)}`,
      );
    }
  }
  if (report.production.length) {
    lines.push("", bold("Production needs:"));
    for (const need of report.production) {
      const holds = need.holds === null ? "unknown" : need.holds ? "has it" : "doesn't have it";
      const mapped = need.mapped === null ? "not in keypin.toml" : `keypin.toml (${need.mapped})`;
      lines.push(
        `  ${mark(need.ok)} ${need.name} in ${need.place} ${dim(`(${need.usedBy.join(", ")}): ${holds}, ${mapped}`)}`,
      );
    }
  }
  const local = report.local.filter((file) => file.unmapped.length || file.elsewhere.length);
  if (local.length) {
    lines.push("", bold("Set in an env file, with no local entry in keypin.toml:"));
    for (const file of local)
      lines.push(`  ${file.file}: ${[...file.unmapped, ...file.elsewhere].join(", ")}`);
  }
  if (report.unknown.length) {
    lines.push("", dim(`Unknown (${report.unknown.length}):`));
    for (const u of report.unknown) lines.push(dim(`  ${u.what}: ${u.reason}`));
  }
  if (report.notes.length) {
    lines.push("", dim(`Notes (${report.notes.length}):`));
    for (const note of report.notes) lines.push(dim(`  ${note}`));
  }
  if (report.problems.length) {
    lines.push("", bold(`Problems (${report.problems.length}):`));
    for (const problem of report.problems) lines.push(`  ${problem}`);
  } else lines.push("", `${mark(true)} Everything checks out.`);
  if (report.add !== null) {
    lines.push(
      "",
      `Add to ${report.map ?? MAP_FILE}, then replace each <...> with the real value (keypin rejects a map that still has one):`,
      "",
      report.add.trimEnd(),
    );
  }
  return tilde(`${lines.join("\n")}\n`, home);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
