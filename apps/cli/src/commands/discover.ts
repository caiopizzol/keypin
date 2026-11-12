import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildDiscovery,
  DEFAULT_ENVIRONMENTS,
  type DiscoverInput,
  type Discovery,
  draftMap,
  envFileKind,
  envNames,
  type KeysMap,
  type NameRow,
  parseMap,
  SKIPPED_FOLDERS,
  type Source,
  type Unknown,
  WRANGLER_FILES,
  workflowRefs,
  wranglerWorkers,
} from "@keypin/core";
import { type Deps, UsageError } from "../deps";
import { errorCode, messageOf } from "../errors";
import { MAP_FILE } from "../project";
import { describeLogin, githubLogin } from "../publisher";
import { registerProject, TEMPLATE } from "./init";

interface Scan {
  envFiles: string[];
  wrangler: string[];
  nested: string[];
}

export async function discover(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new UsageError("keypin discover takes at most one folder");
  const folder = resolve(deps.cwd, positionals[0] ?? ".");
  if (!(await deps.isFolder(folder))) throw new Error(`${folder} isn't a folder`);
  const mapFile = join(folder, MAP_FILE);
  const mapText = await deps.files.read(mapFile);
  if (values.write && mapText !== null && mapText !== TEMPLATE) {
    deps.stderr.write(
      `keypin discover: ${mapFile} already has a map, and --write doesn't change one. Run keypin discover without --write and copy the [keys.*] tables from its draft by hand.\n`,
    );
    return 1;
  }

  const unknowns: Unknown[] = [];
  const scan = await walk(deps, folder);

  const tracked = await trackedFiles(deps, folder, scan.envFiles);
  const envFiles: DiscoverInput["envFiles"] = [];
  for (const path of scan.envFiles) {
    const kind = envFileKind(basename(path));
    if (!kind) continue;
    const text = await deps.files.read(join(folder, path));
    if (text === null) continue;
    envFiles.push({ path, kind, names: envNames(text), tracked: tracked?.has(path) ?? null });
  }
  if (tracked === null && envFiles.some((f) => f.kind === "set")) {
    unknowns.push({
      what: "whether env files are tracked by git",
      reason: "the folder isn't in a git repository",
      cloud: false,
    });
  }

  const top = (await deps.git(folder, ["rev-parse", "--show-toplevel"]))?.trim() || null;
  const workflows = await readWorkflows(deps, folder, top, unknowns);

  const workers: DiscoverInput["workers"] = [];
  for (const config of scan.wrangler) {
    const text = await deps.files.read(join(folder, config));
    if (text === null) continue;
    const parsed = wranglerWorkers(text, config);
    if (!parsed.ok) {
      unknowns.push({
        what: `the Workers in ${config}`,
        reason: "it couldn't be parsed",
        cloud: true,
      });
      continue;
    }
    for (const worker of parsed.workers) {
      const read =
        worker.worker && worker.account
          ? await deps.workerSecrets(worker.account, worker.worker).catch((error: unknown) => ({
              ok: false as const,
              reason: messageOf(error),
            }))
          : null;
      workers.push({ ...worker, read });
    }
  }

  const origin = top ? await githubOrigin(deps, folder) : null;
  let github: DiscoverInput["github"] = null;
  let login: string | null = null;
  if (!top) {
    unknowns.push({
      what: "GitHub Actions secrets",
      reason: "the folder isn't in a git repository",
      cloud: true,
    });
  } else if (!origin || "reason" in origin) {
    unknowns.push({
      what: "GitHub Actions secrets",
      reason: origin?.reason ?? "the repository has no origin remote",
      cloud: true,
    });
  } else {
    login = await githubLogin(deps, folder);
    const read = await deps
      .githubSecrets(origin.repo, login)
      .catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }));
    github = {
      repo: origin.repo,
      read: read.ok ? read : { ok: false, reason: `as ${describeLogin(login)}: ${read.reason}` },
    };
  }

  let map: KeysMap | null = null;
  if (mapText !== null) {
    const parsed = parseMap(mapText, MAP_FILE);
    if (parsed.ok) map = parsed.map;
    else
      unknowns.push({
        what: `which names ${MAP_FILE} maps`,
        reason: parsed.errors.join("; "),
        cloud: false,
      });
  }

  const discovery = buildDiscovery({ envFiles, workflows, workers, github, map, unknowns });
  const draft = draftMap(discovery.names, {
    project: basename(folder),
    map: map ? { account: map.account, vault: firstVault(map) } : null,
    environments: map?.environments ?? DEFAULT_ENVIRONMENTS,
    written: values.write,
  });
  if (values.write && draft === null) {
    deps.stderr.write(
      `keypin discover: found no unmapped name set locally or in the cloud, so there's no draft; nothing was written. Run keypin init for a template.\n`,
    );
    return 1;
  }
  const written =
    values.write && draft !== null ? await writeDraft(deps, mapFile, mapText, draft) : null;

  const report = {
    folder,
    repository: github?.repo ?? null,
    login,
    files: {
      env: envFiles.map(({ path, kind, tracked: t }) => ({ path, kind, tracked: t })),
      wrangler: scan.wrangler,
      workflows: workflows.map((w) => w.path),
    },
    nestedRepositories: scan.nested,
    ...discovery,
    draft,
    written,
  };
  deps.stdout.write(
    values.json ? `${JSON.stringify(report, null, 2)}\n` : render(report, discovery),
  );
  if (written !== null) {
    deps.stderr.write(
      `keypin: wrote the draft to ${written}. Its op:// references are placeholders: replace each with the field's secret reference from 1Password before you run or publish.\n`,
    );
    await registerProject(deps, folder);
  }
  return 0;
}

async function writeDraft(
  deps: Deps,
  file: string,
  found: string | null,
  draft: string,
): Promise<string> {
  const result =
    found === null
      ? await deps.createFile(file, draft)
      : await deps.replaceFile(file, TEMPLATE, draft);
  if (result === "link")
    throw new Error(`${file} is a symbolic link; keypin discover doesn't follow one`);
  if (result === "exists" || result === "changed")
    throw new Error(`${file} changed while discover ran; nothing was written. Run it again.`);
  return file;
}

async function walk(deps: Deps, root: string): Promise<Scan> {
  const scan: Scan = { envFiles: [], wrangler: [], nested: [] };
  const visit = async (folder: string) => {
    const entries = (await deps.listFolder(folder)).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (folder !== root && entries.some((e) => e.name === ".git")) {
      scan.nested.push(relative(root, folder));
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.kind === "folder") {
        if (!SKIPPED_FOLDERS.has(entry.name)) await visit(path);
      } else if (entry.kind === "file") {
        if (envFileKind(entry.name)) scan.envFiles.push(relative(root, path));
        else if (WRANGLER_FILES.includes(entry.name)) scan.wrangler.push(relative(root, path));
      }
    }
  };
  await visit(root);
  return scan;
}

async function trackedFiles(
  deps: Deps,
  folder: string,
  paths: string[],
): Promise<Set<string> | null> {
  if (!paths.length) return new Set();
  const out = await deps.git(folder, ["ls-files", "-z", "--", ...paths]);
  if (out === null) return null;
  return new Set(out.split("\0").filter(Boolean));
}

async function readWorkflows(deps: Deps, folder: string, top: string | null, unknowns: Unknown[]) {
  const dir = join(top ?? folder, ".github", "workflows");
  let entries: Awaited<ReturnType<Deps["listFolder"]>>;
  try {
    entries = await deps.listFolder(dir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      unknowns.push({
        what: "the secrets the workflows use",
        reason: `${relative(folder, dir)} couldn't be read: ${messageOf(error)}`,
        cloud: false,
      });
    }
    return [];
  }
  const workflows: DiscoverInput["workflows"] = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.kind !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
    const text = await deps.files.read(join(dir, entry.name));
    if (text === null) continue;
    const path = relative(folder, join(dir, entry.name));
    const refs = workflowRefs(text);
    if (refs) workflows.push({ path, refs });
    else
      unknowns.push({
        what: `the secrets ${path} uses`,
        reason: "it isn't valid YAML",
        cloud: false,
      });
  }
  return workflows;
}

const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

async function githubOrigin(
  deps: Deps,
  folder: string,
): Promise<{ repo: string; owner: string } | { reason: string } | null> {
  const url = (await deps.git(folder, ["remote", "get-url", "origin"]))?.trim();
  if (!url) return null;
  const match = GITHUB_REMOTE.exec(url);
  if (!match?.[1] || !match[2]) return { reason: "the origin remote isn't on github.com" };
  return { repo: `${match[1]}/${match[2]}`, owner: match[1] };
}

function firstVault(map: KeysMap): string | null {
  const [entry] = map.keys.flatMap((key) => Object.values(key.environments).filter((e) => e));
  return entry?.ref.vault ?? null;
}

const WHERE: Record<NameRow["where"], string> = {
  both: "local and cloud",
  local: "local",
  cloud: "cloud",
  declared: "declared, not set",
  variable: "plain variable",
};

const LABELS: Record<Source["kind"], string> = {
  "env-file": "local",
  "example-file": "expected",
  "github-secret": "cloud",
  "worker-secret": "cloud",
  "workflow-secret": "workflow",
  "workflow-var": "workflow var",
  "worker-required": "required by",
  "worker-var": "var in",
  map: "mapped",
};

function describe(source: Source): string {
  switch (source.kind) {
    case "env-file":
      return source.tracked ? `${source.path} (tracked by git)` : source.path;
    case "example-file":
    case "workflow-secret":
    case "workflow-var":
      return source.path;
    case "worker-required":
    case "worker-var":
      return source.worker ? `${source.path} (${source.worker})` : source.path;
    case "github-secret":
      return `GitHub ${source.repo}${source.updatedAt ? `, updated ${source.updatedAt.slice(0, 10)}` : ""}`;
    case "worker-secret":
      return `Worker ${source.worker} (account ${source.account.slice(0, 8)}…)`;
    case "map":
      return `${source.path} key ${source.keyId}`;
    default: {
      const unknown: never = source;
      return JSON.stringify(unknown);
    }
  }
}

function render(
  report: {
    folder: string;
    repository: string | null;
    login: string | null;
    files: { env: { path: string }[]; wrangler: string[]; workflows: string[] };
    nestedRepositories: string[];
    draft: string | null;
    written: string | null;
  },
  discovery: Discovery,
): string {
  const lines = [`keypin discover ${report.folder}`];
  lines.push(
    `  GitHub: ${report.repository ? `${report.repository} as ${describeLogin(report.login)}` : "no GitHub origin"}`,
  );
  lines.push(
    `  read: ${count(report.files.env.length, "env file")}, ${count(report.files.wrangler.length, "wrangler config")}, ${count(report.files.workflows.length, "workflow")}`,
  );
  if (report.nestedRepositories.length)
    lines.push(`  not scanned (own git repository): ${report.nestedRepositories.join(", ")}`);

  const onlyMissing = (row: NameRow) =>
    row.sources.every((s) => s.kind === "workflow-secret") &&
    discovery.problems.some((p) => p.kind === "missing-github-secret" && p.name === row.name);
  const missing = discovery.names.filter(onlyMissing);
  const shown = discovery.names.filter((row) => !onlyMissing(row));

  lines.push("", `Names (${discovery.names.length}):`);
  for (const row of shown) {
    const where = WHERE[row.where] + (row.cloudUnknown ? ", cloud unknown" : "");
    const mapped = row.mapped.length ? ", mapped" : "";
    lines.push(`  ${row.name}  [${where}${mapped}]`);
    const groups = new Map<string, string[]>();
    for (const source of row.sources) {
      const label = LABELS[source.kind];
      groups.set(label, [...(groups.get(label) ?? []), describe(source)]);
    }
    for (const [label, items] of groups)
      lines.push(`    ${label}: ${[...new Set(items)].join(", ")}`);
    for (const problem of row.problems) lines.push(`    ! ${problem}`);
  }
  if (missing.length) {
    const byWorkflow = new Map<string, string[]>();
    for (const row of missing) {
      const files = row.sources.map(describe).join(", ");
      byWorkflow.set(files, [...(byWorkflow.get(files) ?? []), row.name]);
    }
    const repo = report.repository ?? "the repository";
    lines.push(
      "",
      `Referenced by a workflow, and not a repo secret of ${repo} (${missing.length}):`,
    );
    for (const [files, names] of byWorkflow) lines.push(`  ${files}: ${names.join(", ")}`);
  }
  if (!discovery.names.length) lines.push("  (none found)");

  const loose = discovery.problems.filter((p) => p.name === undefined);
  if (loose.length) {
    lines.push("", `Problems (${loose.length}):`);
    for (const p of loose) lines.push(`  ${p.kind}: ${p.message}`);
  }
  if (discovery.unknowns.length) {
    lines.push("", `Unknown (${discovery.unknowns.length}):`);
    for (const u of discovery.unknowns) lines.push(`  ${u.what}: ${u.reason}`);
  }
  lines.push("");
  if (report.draft === null)
    lines.push("No draft: every name set locally or in the cloud is already mapped.");
  else if (report.written !== null)
    lines.push(
      `Draft keypin.toml for the unmapped names, written to ${report.written}:`,
      "",
      report.draft,
    );
  else lines.push("Draft keypin.toml for the unmapped names (not written):", "", report.draft);
  return `${lines.join("\n").trimEnd()}\n`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
