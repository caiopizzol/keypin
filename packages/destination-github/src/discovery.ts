import { join, relative } from "node:path";
import type {
  Discovered,
  Discovery,
  FoundNeed,
  MapView,
  Place,
  ProjectReader,
  StoreRead,
} from "@keypin/core";
import { usesSecrets, type WorkflowRefs, workflowRefs } from "./workflows";

export interface WorkflowHost {
  git(folder: string, args: readonly string[]): Promise<string | null>;
  githubSecrets(repo: string, login: string | null, environment?: string): Promise<StoreRead>;
}

interface Workflow {
  path: string;
  refs: WorkflowRefs;
}

interface Repo {
  repo: string | null;
  read: StoreRead | null;
  environments: { name: string; read: StoreRead }[];
}

const REPO_PLACEHOLDER = "<owner>/<repo>";

export const workflowDiscovery: Discovery<WorkflowHost> = {
  files: { key: "workflows", noun: "workflow" },
  async scan(project, host) {
    const top = (await host.git(project.root, ["rev-parse", "--show-toplevel"]))?.trim() || null;
    const workflows = await readWorkflows(project, top);
    return { finish: () => lookUp(project, host, top, workflows) };
  },
};

async function readWorkflows(project: ProjectReader, top: string | null): Promise<Workflow[]> {
  const dir = join(top ?? project.root, ".github", "workflows");
  const listed = await project.list(dir);
  if (!listed.ok) {
    if (!listed.missing)
      project.unknown(
        "the secrets the workflows use",
        `${relative(project.root, dir)} couldn't be read: ${listed.reason}`,
      );
    return [];
  }
  const workflows: Workflow[] = [];
  for (const entry of listed.entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.kind !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
    const path = relative(project.root, join(dir, entry.name));
    const text = await project.read(path);
    if (text === null) continue;
    const refs = workflowRefs(text);
    if (refs) workflows.push({ path, refs });
    else project.unknown(`the secrets ${path} uses`, "it isn't valid YAML");
  }
  return workflows;
}

async function lookUp(
  project: ProjectReader,
  host: WorkflowHost,
  top: string | null,
  workflows: Workflow[],
): Promise<Discovered> {
  for (const workflow of workflows)
    if (workflow.refs.hidesUses)
      project.unknown(
        `every secret ${workflow.path} uses`,
        "it passes secrets on (secrets: inherit or toJSON(secrets)), so check can't tell which",
      );
  const uses = usesSecrets(workflows);
  const origin = top ? await githubOrigin(host, project.root) : null;
  const github: Repo = { repo: null, read: null, environments: [] };
  let login: string | null = null;
  const reading = (repo: string, environment?: string) =>
    host
      .githubSecrets(repo, login, environment)
      .catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }));
  if (origin && "repo" in origin) {
    github.repo = origin.repo;
    if (uses) {
      login = (await host.git(project.root, ["config", "--get", "github.account"]))?.trim() || null;
      const read = await reading(origin.repo);
      github.read = read;
      if (!read.ok)
        project.unknown(
          `the Actions secrets of ${origin.repo}`,
          `as ${describeLogin(login)}: ${read.reason}`,
        );
      for (const name of jobEnvironments(workflows)) {
        const read = await reading(origin.repo, name);
        github.environments.push({ name, read });
        if (!read.ok)
          project.unknown(
            `the secrets of the environment ${name} in ${origin.repo}`,
            `as ${describeLogin(login)}: ${read.reason}`,
          );
      }
    }
  } else if (uses) {
    project.unknown(
      "the GitHub repository's Actions secrets",
      !top
        ? "the folder isn't in a git repository"
        : (origin?.reason ?? "the repository has no origin remote"),
    );
  }
  return {
    files: workflows.map((w) => w.path),
    used: uses,
    about: github.repo ? `GitHub ${github.repo}` : null,
    report: { github: { repo: github.repo, login } },
    needs: (view) => needsOf(github, workflows, view),
  };
}

function needsOf(github: Repo, workflows: Workflow[], view: MapView) {
  const declared = new Map<string, Set<string>>();
  const repo = githubPlace(github, null, declared);
  const uses = workflows.flatMap((workflow) =>
    workflow.refs.uses.flatMap(({ environment, secrets }) =>
      secrets
        .filter((name) => !name.startsWith("GITHUB_"))
        .map((name) => ({ name, path: workflow.path, environment })),
    ),
  );
  const needs: FoundNeed[] = [];
  for (const use of uses) {
    const literal = literalEnvironment(use.environment);
    const environment = literal === null ? null : githubPlace(github, literal, declared);
    const alone = uses
      .filter((u) => u.name === use.name)
      .every((u) => literalEnvironment(u.environment)?.toLowerCase() === literal?.toLowerCase());
    const place =
      environment !== null &&
      (view.publishes(use.name, environment) ||
        (alone && !view.publishes(use.name, repo) && repo.holds(use.name) === false))
        ? environment
        : repo;
    if (place === repo && use.environment !== null)
      declared.set(use.name, (declared.get(use.name) ?? new Set()).add(use.environment));
    needs.push({ name: use.name, place, usedBy: use.path });
  }
  const hidden = workflows.some((w) => w.refs.hidesUses);
  return {
    needs,
    notes: [],
    notesAfter(found: readonly { name: string; place: string }[]) {
      if (!hidden || !github.read?.ok) return [];
      const unmapped = github.read.secrets
        .map((s) => s.name)
        .filter(
          (name) =>
            !found.some((n) => n.place === repo.id && n.name === name.toUpperCase()) &&
            !view.publishes(name.toUpperCase(), repo),
        );
      return unmapped.length
        ? [
            `${repo.label} has ${unmapped.join(", ")}, which no workflow names and keypin.toml doesn't publish there; a workflow that passes secrets on may use them`,
          ]
        : [];
    },
  };
}

function githubPlace(
  github: Repo,
  environment: string | null,
  declared: ReadonlyMap<string, ReadonlySet<string>>,
): Place {
  const repo = github.repo;
  const env = environment?.toLowerCase();
  const read =
    env === undefined
      ? github.read
      : github.environments.find((e) => e.name.toLowerCase() === env)?.read;
  const held = read?.ok ? new Set(read.secrets.map((s) => s.name.toUpperCase())) : null;
  const fields: [string, string][] = [
    ["to", "github-actions"],
    ["repo", repo ?? REPO_PLACEHOLDER],
  ];
  if (environment !== null) fields.push(["environment", environment]);
  return {
    id: `github-actions:${repo?.toLowerCase() ?? ""}${env === undefined ? "" : `/environments/${env}`}`,
    to: "github-actions",
    label: `${repo ?? "the GitHub repository"}${environment === null ? "" : ` (environment ${environment})`}`,
    verb: "uses",
    fields,
    ...(environment === null
      ? { aside: (name: string) => maybeEnvironment([...(declared.get(name) ?? [])]) }
      : {}),
    matches: (keyName, name) => keyName.toUpperCase() === name,
    covers: (target) =>
      target.to === "github-actions" &&
      (repo === null || target.repo?.toLowerCase() === repo.toLowerCase()) &&
      target.environment?.toLowerCase() === env,
    holds: (name) => (held ? held.has(name.toUpperCase()) : null),
  };
}

function maybeEnvironment(environments: readonly string[]): string {
  return environments.length
    ? ` as a repo secret (it may be a secret of the environment ${environments.join(" or ")}, which check doesn't read)`
    : "";
}

function literalEnvironment(environment: string | null): string | null {
  return environment === null || environment.includes("${{") ? null : environment;
}

function describeLogin(login: string | null): string {
  return login === null ? "the active gh login" : `${login} (git config github.account)`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jobEnvironments(workflows: readonly Workflow[]): string[] {
  const names = new Map<string, string>();
  for (const workflow of workflows)
    for (const use of workflow.refs.uses)
      if (
        use.environment !== null &&
        !use.environment.includes("${{") &&
        use.secrets.some((name) => !name.startsWith("GITHUB_"))
      )
        if (!names.has(use.environment.toLowerCase()))
          names.set(use.environment.toLowerCase(), use.environment);
  return [...names.values()];
}

const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/:]+@)?[^/:]+(?::\d+)?\/|(?:[^@/:]+@)?[^/:]+:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

async function githubOrigin(
  host: WorkflowHost,
  folder: string,
): Promise<{ repo: string } | { reason: string } | null> {
  const url = (await host.git(folder, ["remote", "get-url", "origin"]))?.trim();
  if (!url) return null;
  const match = GITHUB_REMOTE.exec(url);
  if (!match?.[1] || !match[2]) return { reason: "the origin remote isn't on github.com" };
  return { repo: `${match[1]}/${match[2]}` };
}
