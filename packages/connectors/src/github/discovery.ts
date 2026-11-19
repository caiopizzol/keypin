import { join, relative } from "node:path";
import {
  type Discovered,
  type Discovery,
  type FoundNeed,
  type MapView,
  messageOf,
  type Place,
  type ProjectReader,
  type Pulled,
  type StoreRead,
} from "@keypin/core";
import { NOT_ENTERPRISE } from "./refusal";
import { isSshName } from "./ssh";
import { usesSecrets, type WorkflowRefs, workflowRefs } from "./workflows";

export interface WorkflowHost {
  git(folder: string, args: readonly string[]): Promise<string | null>;
  githubSecrets(repo: string, login: string | null, environment?: string): Promise<StoreRead>;
  organizationSecrets(repo: string, login: string | null): Promise<StoreRead>;
  sshHostname(destination: string): Promise<string | null>;
}

interface Workflow {
  path: string;
  refs: WorkflowRefs;
}

interface Repo {
  repo: string | null;
  read: StoreRead | null;
  organization: StoreRead | null;
  environments: { name: string; read: StoreRead }[];
  pulled: { pulled: Pulled; repo: string; environment: string | null; read: StoreRead }[];
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
        "it passes secrets on (secrets: inherit or toJSON(secrets)) or names one by an expression (secrets[...]), so check can't tell which",
      );
  const uses = usesSecrets(workflows);
  const origin = top ? await githubOrigin(host, project.root) : null;
  const github: Repo = {
    repo: null,
    read: null,
    organization: null,
    environments: [],
    pulled: [],
  };
  let login: string | null = null;
  const reading = (repo: string, environment?: string) =>
    host
      .githubSecrets(repo, login, environment)
      .catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }));
  if (origin && "repo" in origin) {
    github.repo = origin.repo;
    if (uses) {
      login = await configuredLogin(host, project);
      const read = await reading(origin.repo);
      github.read = read;
      if (!read.ok)
        project.unknown(
          `the Actions secrets of ${origin.repo}`,
          `as ${describeLogin(login)}: ${read.reason}`,
        );
      else {
        const shared = await host
          .organizationSecrets(origin.repo, login)
          .catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }));
        github.organization = shared;
        if (!shared.ok)
          project.unknown(
            `the organization secrets shared with ${origin.repo}`,
            `as ${describeLogin(login)}: ${shared.reason}`,
          );
      }
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
  if (project.pulled.some(({ reader }) => reader.by === "github-actions"))
    await readPulled(project, host, github, login ?? (await configuredLogin(host, project)));
  return {
    files: workflows.map((w) => w.path),
    used: uses || github.pulled.length > 0,
    about: github.repo ? `GitHub ${github.repo}` : null,
    report: { github: { repo: github.repo, login } },
    needs: (view) => needsOf(github, workflows, view),
  };
}

async function configuredLogin(host: WorkflowHost, project: ProjectReader) {
  return (await host.git(project.root, ["config", "--get", "github.account"]))?.trim() || null;
}

async function readPulled(
  project: ProjectReader,
  host: WorkflowHost,
  github: Repo,
  login: string | null,
): Promise<void> {
  const reads = new Map<string, StoreRead>();
  for (const pulled of project.pulled) {
    const { by, repo, environment } = pulled.reader;
    if (by !== "github-actions" || repo === undefined) continue;
    const place = placeOf(repo, environment ?? null);
    let read = reads.get(place) ?? knownRead(github, repo, environment ?? null);
    if (read === undefined) {
      read = await host
        .githubSecrets(repo, login, environment)
        .catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }));
      if (!read.ok)
        project.unknown(
          `the Actions secrets of ${describePlace(repo, environment ?? null)}`,
          `as ${describeLogin(login)}: ${read.reason}`,
        );
    }
    reads.set(place, read);
    github.pulled.push({ pulled, repo, environment: environment ?? null, read });
  }
}

function knownRead(github: Repo, repo: string, environment: string | null): StoreRead | undefined {
  if (github.repo?.toLowerCase() !== repo.toLowerCase()) return undefined;
  if (environment === null) return github.read ?? undefined;
  return github.environments.find((e) => e.name.toLowerCase() === environment.toLowerCase())?.read;
}

function placeOf(repo: string, environment: string | null): string {
  return `${repo.toLowerCase()}${environment === null ? "" : `/environments/${environment.toLowerCase()}`}`;
}

function describePlace(repo: string, environment: string | null): string {
  return environment === null ? repo : `${repo} environment ${environment}`;
}

function needsOf(github: Repo, workflows: Workflow[], view: MapView) {
  const declared = new Map<string, Set<string>>();
  const repo = githubPlace(github, null, declared, view);
  const uses = workflows.flatMap((workflow) =>
    workflow.refs.uses.flatMap(({ environment, secrets, fromCaller }) =>
      secrets
        .filter((name) => !name.startsWith("GITHUB_"))
        .map((name) => ({ name, path: workflow.path, environment, fromCaller })),
    ),
  );
  const required = uses.filter((use) => !use.fromCaller);
  const needs: FoundNeed[] = [];
  const shared = namesOf(github.organization);
  const fromOrganization = new Map<string, { paths: string[]; environments: string[] }>();
  const here = github.pulled.filter(
    (p) => github.repo !== null && p.repo.toLowerCase() === github.repo.toLowerCase(),
  );
  const leftover = new Map<PulledAt, string[]>();
  for (const use of uses) {
    if (view.ignores(use.name)) {
      needs.push({ name: use.name, place: repo, usedBy: use.path });
      continue;
    }
    const pulled = here.find(
      (p) => p.pulled.key.toUpperCase() === use.name && reaches(p, use.environment),
    );
    if (pulled) {
      const paths = leftover.get(pulled) ?? [];
      if (!paths.includes(use.path)) paths.push(use.path);
      leftover.set(pulled, paths);
      continue;
    }
    const literal = literalEnvironment(use.environment);
    const environment = literal === null ? null : githubPlace(github, literal, declared, view);
    if (
      environment !== null &&
      (environment.holds(use.name) === true || view.publishes(use.name, environment))
    ) {
      needs.push({ name: use.name, place: environment, usedBy: use.path });
      continue;
    }
    if (use.fromCaller) continue;
    if (
      shared?.has(use.name) &&
      repo.holds(use.name) === false &&
      (environment === null || environment.holds(use.name) === false) &&
      !view.publishes(use.name, repo)
    ) {
      const org = fromOrganization.get(use.name) ?? { paths: [], environments: [] };
      if (!org.paths.includes(use.path)) org.paths.push(use.path);
      if (
        literal === null &&
        use.environment !== null &&
        !org.environments.includes(use.environment)
      )
        org.environments.push(use.environment);
      fromOrganization.set(use.name, org);
      continue;
    }
    const alone = required
      .filter((u) => u.name === use.name)
      .every((u) => literalEnvironment(u.environment)?.toLowerCase() === literal?.toLowerCase());
    const place =
      environment !== null &&
      repo.holds(use.name) === false &&
      !view.publishes(use.name, repo) &&
      (alone || environment.holds(use.name) === null)
        ? environment
        : repo;
    if (place === repo && environment === null && use.environment !== null)
      declared.set(use.name, (declared.get(use.name) ?? new Set()).add(use.environment));
    needs.push({ name: use.name, place, usedBy: use.path });
  }
  const hidden = workflows.some((w) => w.refs.hidesUses);
  return {
    needs,
    problems: leftovers(github, leftover),
    notes: [
      ...pullNotes(github.repo, here, workflows, view),
      ...[...fromOrganization].map(
        ([name, { paths, environments }]) =>
          `${name}: ${paths.join(", ")} uses it; ${repo.label} has it (org secret), which keypin.toml doesn't publish${
            environments.length
              ? ` (a secret of the environment ${environments.join(" or ")}, which check doesn't read, would take its place)`
              : ""
          }`,
      ),
    ],
    notesAfter(found: readonly { name: string; place: string }[]) {
      if (!hidden || !github.read?.ok) return [];
      const unmapped = github.read.secrets
        .map((s) => s.name)
        .filter(
          (name) =>
            !found.some((n) => n.place === repo.id && n.name === name.toUpperCase()) &&
            !view.publishes(name.toUpperCase(), repo) &&
            !view.ignores(name) &&
            !here.some(
              (p) => p.environment === null && p.pulled.key.toUpperCase() === name.toUpperCase(),
            ),
        );
      return unmapped.length
        ? [
            `${repo.label} has ${unmapped.join(", ")}, which no workflow names and keypin.toml doesn't publish there; a workflow that passes secrets on may use them`,
          ]
        : [];
    },
  };
}

type PulledAt = Repo["pulled"][number];

function reaches(pulled: PulledAt, jobEnvironment: string | null): boolean {
  if (pulled.environment === null) return true;
  return literalEnvironment(jobEnvironment)?.toLowerCase() === pulled.environment.toLowerCase();
}

function leftovers(github: Repo, references: ReadonlyMap<PulledAt, string[]>): string[] {
  const problems = new Map<string, string>();
  for (const pulled of github.pulled) {
    const { key, environment } = pulled.pulled;
    const where = `${key} ${placeOf(pulled.repo, pulled.environment)}`;
    if (problems.has(where)) continue;
    const paths = github.pulled
      .filter((p) => `${p.pulled.key} ${placeOf(p.repo, p.environment)}` === where)
      .flatMap((p) => references.get(p) ?? []);
    const stored =
      pulled.read.ok && pulled.read.secrets.some((s) => s.name.toUpperCase() === key.toUpperCase());
    if (!stored && !paths.length) continue;
    const place = describePlace(pulled.repo, pulled.environment);
    const facts = [
      ...(paths.length
        ? [
            `${paths.join(", ")} still ${paths.length === 1 ? "uses" : "use"} secrets.${key.toUpperCase()}`,
          ]
        : []),
      ...(stored ? [`${place} still has it as an Actions secret`] : []),
    ];
    const fixes = [
      ...(paths.length
        ? [`read it with keypin run --env ${environment} --only ${key} -- <command> instead`]
        : []),
      ...(stored
        ? [
            `delete the Actions secret: gh secret delete ${key} --repo ${pulled.repo}${pulled.environment === null ? "" : ` --env ${pulled.environment}`}`,
          ]
        : []),
    ];
    problems.set(
      where,
      `${key}: keypin.toml says jobs in ${place} pull it from the vault at job time, but ${facts.join(" and ")}; ${fixes.join(", then ")}`,
    );
  }
  return [...problems.values()];
}

function pullNotes(
  repo: string | null,
  here: readonly PulledAt[],
  workflows: readonly Workflow[],
  view: MapView,
): string[] {
  if (repo === null || !workflows.length) return [];
  const notes = new Set<string>();
  for (const { path, refs } of workflows)
    for (const run of refs.runs)
      for (const key of run.only ?? []) {
        if (here.some((p) => p.pulled.key === key && reaches(p, run.environment))) continue;
        const literal = literalEnvironment(run.environment);
        const fields = [`by = "github-actions"`, `repo = "${repo}"`];
        if (literal !== null) fields.push(`environment = "${literal}"`);
        notes.add(
          `${key}: ${path} reads it with keypin run, but keypin.toml has no pull entry for ${describePlace(repo, literal)}; add [[keys.${key}.${run.env ?? view.runEnvironment}.pull]] with ${fields.join(", ")}`,
        );
      }
  for (const pulled of here) {
    const { key } = pulled.pulled;
    const used = workflows.some(({ refs }) =>
      refs.runs.some(
        (run) => reaches(pulled, run.environment) && (run.only?.includes(key) ?? true),
      ),
    );
    if (!used)
      notes.add(
        `${key}: keypin.toml says jobs in ${describePlace(pulled.repo, pulled.environment)} pull it, but no workflow there runs keypin run for it`,
      );
  }
  return [...notes];
}

function githubPlace(
  github: Repo,
  environment: string | null,
  declared: ReadonlyMap<string, ReadonlySet<string>>,
  view: MapView,
): Place {
  const repo = github.repo;
  const env = environment?.toLowerCase();
  const read =
    env === undefined
      ? github.read
      : github.environments.find((e) => e.name.toLowerCase() === env)?.read;
  const held = read?.ok ? new Set(read.secrets.map((s) => s.name.toUpperCase())) : null;
  const shared = env === undefined ? namesOf(github.organization) : new Set<string>();
  const holds = (name: string) =>
    held === null
      ? null
      : held.has(name.toUpperCase())
        ? true
        : shared === null && !view.publishes(name, place)
          ? null
          : false;
  const fields: [string, string][] = [
    ["to", "github-actions"],
    ["repo", repo ?? REPO_PLACEHOLDER],
  ];
  if (environment !== null) fields.push(["environment", environment]);
  const place: Place = {
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
    holds,
  };
  return place;
}

function namesOf(read: StoreRead | null): Set<string> | null {
  return read?.ok ? new Set(read.secrets.map((s) => s.name.toUpperCase())) : null;
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
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:([^@/:]+)@)?([^/:]+)(?::\d+)?\/|(?:([^@/:]+)@)?([^/:]+):)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_HOST = /^(?:ssh\.)?github\.com$/i;
const NOT_GITHUB = "the origin remote isn't on github.com";
const ENTERPRISE_HOST = /^(?!(?:ssh\.)?github\.com$).*(?:github|(?:^|\.)ghe\.com$)/i;

function notGitHub(host: string | undefined): { reason: string } {
  return {
    reason: host && ENTERPRISE_HOST.test(host) ? `${NOT_GITHUB}; ${NOT_ENTERPRISE}` : NOT_GITHUB,
  };
}

function hostOf(url: string): string | undefined {
  return /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1];
}

async function githubOrigin(
  host: WorkflowHost,
  folder: string,
): Promise<{ repo: string } | { reason: string } | null> {
  const url = (await host.git(folder, ["remote", "get-url", "origin"]))?.trim();
  if (!url) return null;
  const [, sshUser, sshHost, scpUser, scpHost, owner, name] = GITHUB_REMOTE.exec(url) ?? [];
  if (!owner || !name) return notGitHub(hostOf(url));
  const alias = sshHost ?? scpHost;
  const user = sshUser ?? scpUser;
  if (alias !== undefined && !GITHUB_SSH_HOST.test(alias)) {
    if (!isSshName(alias) || (user !== undefined && !isSshName(user)))
      return {
        reason:
          "the origin remote's SSH host or user isn't a plain name, so check didn't ask ssh which server it is",
      };
    const real = await host
      .sshHostname(user === undefined ? alias : `${user}@${alias}`)
      .catch(() => null);
    if (real === null)
      return {
        reason: `ssh -G couldn't tell which server the origin remote's host ${alias} is, so check can't tell whether it's on github.com`,
      };
    if (!GITHUB_SSH_HOST.test(real)) return notGitHub(real);
  }
  return { repo: `${owner}/${name}` };
}
