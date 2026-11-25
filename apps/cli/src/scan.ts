import { basename, join, matchesGlob, relative } from "node:path";
import {
  type Discovered,
  envFileKind,
  envNames,
  type FolderListing,
  ignores,
  type JobReader,
  type KeysMap,
  messageOf,
  type ProjectFiles,
  type ProjectReader,
  type ProjectScan,
} from "@keypin/core";
import type { Deps } from "./deps";
import { errorCode } from "./errors";

const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".output",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".turbo",
  ".vercel",
  ".netlify",
  ".cache",
  ".parcel-cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  "Pods",
  "DerivedData",
]);

export interface Unknown {
  what: string;
  reason: string;
}

export interface ScanResult {
  scan: ProjectScan;
  files: Record<string, string[]>;
  read: { noun: string; count: number; others: number }[];
  about: string[];
  report: Record<string, unknown>;
  used: Map<string, boolean>;
  nested: string[];
  unknowns: Unknown[];
  problems: string[];
}

export async function scanProject(
  deps: Deps,
  root: string,
  map: Pick<KeysMap, "ignore" | "scanFiles"> | null,
): Promise<ScanResult> {
  const ignore = map?.ignore ?? [];
  const unknowns: Unknown[] = [];
  const kinds = deps.destinations.flatMap((kind) =>
    kind.discovery ? [{ kind: kind.kind, discovery: kind.discovery }] : [],
  );
  const walked = kinds.filter(({ discovery }) => discovery.files.names);
  const found = await walk(deps, root, unknowns, walked);
  const scope = map?.scanFiles ? await scopeOf(deps, root, map.scanFiles) : null;
  if (scope && scope.top !== root) {
    const repo = await walk(deps, scope.top, unknowns, walked);
    for (const [kind, paths] of repo.byKind) {
      const fromTop = paths.map((path) => relative(root, join(scope.top, path)));
      found.byKind.set(kind, [...new Set([...(found.byKind.get(kind) ?? []), ...fromTop])]);
    }
  }

  const tracked = await trackedFiles(deps, root, found.envFiles);
  const envFiles: ProjectScan["envFiles"] = [];
  for (const path of found.envFiles) {
    const kind = envFileKind(basename(path));
    if (!kind) continue;
    const text = await readSource(deps, root, path, unknowns);
    if (text === null) continue;
    envFiles.push({ path, kind, names: envNames(text), tracked: tracked?.has(path) ?? null });
  }
  if (tracked === null && envFiles.some((f) => f.kind === "set"))
    unknowns.push({
      what: "whether env files are tracked by git",
      reason: "the folder isn't in a git repository",
    });

  const others = new Map<string, Set<string>>();
  const reader = (kind: string, found: readonly string[]): ProjectReader => ({
    root,
    found,
    ignores: (name) => ignores(ignore, name),
    owns: !scope
      ? null
      : (path) => {
          const file = relative(scope.top, join(root, path));
          const globs = scope.globs.filter((glob) => matchesGlob(file, glob));
          for (const glob of globs) scope.matched.add(glob);
          if (!globs.length) others.set(kind, (others.get(kind) ?? new Set()).add(path));
          return globs.length > 0;
        },
    read: (path) => readSource(deps, root, path, unknowns),
    list: (folder) => listing(deps, folder),
    unknown: (what, reason) => unknowns.push({ what, reason }),
  });
  const scanned = [];
  for (const { kind, discovery } of kinds)
    scanned.push(await discovery.scan(reader(kind, found.byKind.get(kind) ?? []), deps));
  const discovered: Discovered[] = [];
  for (const scan of scanned) discovered.push(await scan.finish());

  const byKind = kinds.map(({ kind, discovery }, i) => ({ kind, discovery, found: discovered[i] }));
  const listed = [
    ...byKind.filter(({ discovery }) => discovery.files.names),
    ...byKind.filter(({ discovery }) => !discovery.files.names),
  ];
  const files: Record<string, string[]> = { env: envFiles.map((f) => f.path) };
  const read = [{ noun: "env file", count: envFiles.length, others: 0 }];
  for (const { kind, discovery, found } of listed) {
    files[discovery.files.key] = [...(found?.files ?? [])];
    read.push({
      noun: discovery.files.noun,
      count: found?.files.length ?? 0,
      others: others.get(kind)?.size ?? 0,
    });
  }
  const nouns = listed.map(({ discovery }) => discovery.files.noun).join(" or ");
  return {
    scan: { envFiles, discovered, complete: !unknowns.length },
    files,
    read,
    about: discovered.flatMap((d) => (d.about === null ? [] : [d.about])),
    report: merged(byKind.map(({ kind, found }) => ({ kind, report: found?.report ?? {} }))),
    used: new Map(byKind.map(({ kind, found }) => [kind, found?.used ?? false])),
    nested: found.nested,
    unknowns,
    problems: (scope?.globs ?? [])
      .filter((glob) => !scope?.matched.has(glob))
      .map((glob) => `scan_files "${glob}" matches no ${nouns}; fix or remove it`),
  };
}

async function scopeOf(deps: Deps, root: string, globs: readonly string[]) {
  const top = (await deps.git(root, ["rev-parse", "--show-toplevel"]))?.trim() || root;
  return { top, globs, matched: new Set<string>() };
}

export async function jobReaders(deps: Deps, root: string, profile: string): Promise<JobReader[]> {
  const reader: ProjectReader = {
    root,
    found: [],
    ignores: () => false,
    owns: null,
    read: (path) => readSource(deps, root, path, []),
    list: (folder) => listing(deps, folder),
    unknown: () => undefined,
  };
  const found: JobReader[] = [];
  for (const { discovery } of deps.destinations)
    if (discovery?.readers) found.push(...(await discovery.readers(reader, deps, profile)));
  return found;
}

function merged(reports: { kind: string; report: Readonly<Record<string, unknown>> }[]) {
  const all: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const { kind, report } of reports)
    for (const [key, value] of Object.entries(report)) {
      const first = owner.get(key);
      if (first) throw new Error(`the ${first} and ${kind} destinations both report ${key}`);
      owner.set(key, kind);
      all[key] = value;
    }
  return all;
}

async function listing(deps: Deps, folder: string): Promise<FolderListing> {
  try {
    return { ok: true, entries: await deps.listFolder(folder) };
  } catch (error) {
    return { ok: false, missing: errorCode(error) === "ENOENT", reason: messageOf(error) };
  }
}

async function walk(
  deps: Deps,
  root: string,
  unknowns: Unknown[],
  kinds: readonly {
    kind: string;
    discovery: { files: ProjectFiles };
  }[],
) {
  const found: { envFiles: string[]; byKind: Map<string, string[]>; nested: string[] } = {
    envFiles: [],
    byKind: new Map(),
    nested: [],
  };
  const nouns = ["env file", ...kinds.map(({ discovery }) => discovery.files.noun)];
  const skipped = new Set([
    ...SKIPPED_FOLDERS,
    ...kinds.flatMap(({ discovery }) => discovery.files.skip ?? []),
  ]);
  const visit = async (folder: string) => {
    let listed: Awaited<ReturnType<Deps["listFolder"]>>;
    try {
      listed = await deps.listFolder(folder);
    } catch (error) {
      unknowns.push({
        what: `the ${list(nouns.map((noun) => `${noun}s`))} in ${relative(root, folder) || "."}`,
        reason: `it couldn't be read: ${messageOf(error)}`,
      });
      return;
    }
    const entries = listed.toSorted((a, b) => a.name.localeCompare(b.name));
    if (folder !== root && entries.some((e) => e.name === ".git")) {
      found.nested.push(relative(root, folder));
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.kind === "folder") {
        if (!skipped.has(entry.name)) await visit(path);
      } else if (entry.kind === "file") {
        if (envFileKind(entry.name)) found.envFiles.push(relative(root, path));
        else {
          const owner = kinds.find(({ discovery }) => discovery.files.names?.includes(entry.name));
          if (owner)
            found.byKind.set(owner.kind, [
              ...(found.byKind.get(owner.kind) ?? []),
              relative(root, path),
            ]);
        }
      }
    }
  };
  await visit(root);
  return found;
}

function list(items: readonly string[]): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
    : (items[0] ?? "");
}

async function readSource(
  deps: Deps,
  root: string,
  path: string,
  unknowns: Unknown[],
): Promise<string | null> {
  try {
    return await deps.files.read(join(root, path));
  } catch (error) {
    unknowns.push({
      what: `the names in ${path}`,
      reason: `it couldn't be read: ${messageOf(error)}`,
    });
    return null;
  }
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
