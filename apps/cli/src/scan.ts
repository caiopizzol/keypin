import { basename, join, relative } from "node:path";
import {
  envFileKind,
  envNames,
  type ProjectScan,
  SKIPPED_FOLDERS,
  WRANGLER_FILES,
  workflowRefs,
  wranglerWorkers,
} from "@keypin/core";
import type { Deps } from "./deps";
import { errorCode, messageOf } from "./errors";
import { describeLogin, githubLogin } from "./publisher";

export interface Unknown {
  what: string;
  reason: string;
}

export interface ScanResult {
  scan: ProjectScan;
  files: { env: string[]; wrangler: string[]; workflows: string[] };
  nested: string[];
  login: string | null;
  unknowns: Unknown[];
}

export async function scanProject(deps: Deps, root: string): Promise<ScanResult> {
  const unknowns: Unknown[] = [];
  const found = await walk(deps, root);

  const tracked = await trackedFiles(deps, root, found.envFiles);
  const envFiles: ProjectScan["envFiles"] = [];
  for (const path of found.envFiles) {
    const kind = envFileKind(basename(path));
    if (!kind) continue;
    const text = await deps.files.read(join(root, path));
    if (text === null) continue;
    envFiles.push({ path, kind, names: envNames(text), tracked: tracked?.has(path) ?? null });
  }
  if (tracked === null && envFiles.some((f) => f.kind === "set"))
    unknowns.push({
      what: "whether env files are tracked by git",
      reason: "the folder isn't in a git repository",
    });

  const top = (await deps.git(root, ["rev-parse", "--show-toplevel"]))?.trim() || null;
  const workflows = await readWorkflows(deps, root, top, unknowns);

  const workers: ProjectScan["workers"] = [];
  for (const config of found.wrangler) {
    const text = await deps.files.read(join(root, config));
    if (text === null) continue;
    const parsed = wranglerWorkers(text, config);
    if (!parsed.ok) {
      unknowns.push({ what: `the Workers in ${config}`, reason: "it couldn't be parsed" });
      continue;
    }
    for (const worker of parsed.workers) {
      const label = `the secrets of the Worker ${worker.worker ?? `in ${config}`}`;
      let read: ProjectScan["workers"][number]["read"] = null;
      if (worker.required?.length) {
        if (!worker.worker) unknowns.push({ what: label, reason: `${config} names no Worker` });
        else if (!worker.account)
          unknowns.push({
            what: label,
            reason: `${config} has no account_id, and check doesn't guess an account`,
          });
        else {
          read = await deps
            .workerSecrets(worker.account, worker.worker)
            .catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }));
          if (!read.ok) unknowns.push({ what: label, reason: read.reason });
        }
      }
      workers.push({ ...worker, read });
    }
  }

  const uses = workflows.some((w) => w.refs.secrets.some((name) => !name.startsWith("GITHUB_")));
  const origin = top ? await githubOrigin(deps, root) : null;
  const github: ProjectScan["github"] = { repo: null, read: null };
  let login: string | null = null;
  if (origin && "repo" in origin) {
    github.repo = origin.repo;
    if (uses) {
      login = await githubLogin(deps, root);
      const read = await deps
        .githubSecrets(origin.repo, login)
        .catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }));
      github.read = read;
      if (!read.ok)
        unknowns.push({
          what: `the Actions secrets of ${origin.repo}`,
          reason: `as ${describeLogin(login)}: ${read.reason}`,
        });
    }
  } else if (uses) {
    unknowns.push({
      what: "the GitHub repository's Actions secrets",
      reason: !top
        ? "the folder isn't in a git repository"
        : (origin?.reason ?? "the repository has no origin remote"),
    });
  }

  return {
    scan: { envFiles, workflows, workers, github },
    files: {
      env: envFiles.map((f) => f.path),
      wrangler: found.wrangler,
      workflows: workflows.map((w) => w.path),
    },
    nested: found.nested,
    login,
    unknowns,
  };
}

async function walk(deps: Deps, root: string) {
  const found: { envFiles: string[]; wrangler: string[]; nested: string[] } = {
    envFiles: [],
    wrangler: [],
    nested: [],
  };
  const visit = async (folder: string) => {
    const entries = (await deps.listFolder(folder)).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (folder !== root && entries.some((e) => e.name === ".git")) {
      found.nested.push(relative(root, folder));
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.kind === "folder") {
        if (!SKIPPED_FOLDERS.has(entry.name)) await visit(path);
      } else if (entry.kind === "file") {
        if (envFileKind(entry.name)) found.envFiles.push(relative(root, path));
        else if (WRANGLER_FILES.includes(entry.name)) found.wrangler.push(relative(root, path));
      }
    }
  };
  await visit(root);
  return found;
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

async function readWorkflows(deps: Deps, root: string, top: string | null, unknowns: Unknown[]) {
  const dir = join(top ?? root, ".github", "workflows");
  let entries: Awaited<ReturnType<Deps["listFolder"]>>;
  try {
    entries = await deps.listFolder(dir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      unknowns.push({
        what: "the secrets the workflows use",
        reason: `${relative(root, dir)} couldn't be read: ${messageOf(error)}`,
      });
    return [];
  }
  const workflows: ProjectScan["workflows"] = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.kind !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
    const text = await deps.files.read(join(dir, entry.name));
    if (text === null) continue;
    const path = relative(root, join(dir, entry.name));
    const refs = workflowRefs(text);
    if (refs) workflows.push({ path, refs });
    else unknowns.push({ what: `the secrets ${path} uses`, reason: "it isn't valid YAML" });
  }
  return workflows;
}

const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

async function githubOrigin(
  deps: Deps,
  folder: string,
): Promise<{ repo: string } | { reason: string } | null> {
  const url = (await deps.git(folder, ["remote", "get-url", "origin"]))?.trim();
  if (!url) return null;
  const match = GITHUB_REMOTE.exec(url);
  if (!match?.[1] || !match[2]) return { reason: "the origin remote isn't on github.com" };
  return { repo: `${match[1]}/${match[2]}` };
}
