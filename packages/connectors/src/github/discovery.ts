import { join, relative } from "node:path";
import {
  type Discovered,
  type Discovery,
  messageOf,
  type ProjectReader,
  type StoreRead,
} from "@keypin/core";
import { usesSecrets, workflowRefs } from "./workflows";
import { needsOf } from "./discovery-needs";
import { githubOrigin } from "./discovery-origin";
import { describePlace, placeOf } from "./discovery-places";
import type { Repo, Workflow, WorkflowHost } from "./discovery-repo";

export type { WorkflowHost } from "./discovery-repo";

export const workflowDiscovery: Discovery<WorkflowHost> = {
  files: { key: "workflows", noun: "workflow" },
  async scan(project, host) {
    const top = (await host.git(project.root, ["rev-parse", "--show-toplevel"]))?.trim() || null;
    const { workflows, complete } = await readWorkflows(project, top);
    return { finish: () => lookUp(project, host, top, workflows, complete) };
  },
};

async function readWorkflows(
  project: ProjectReader,
  top: string | null,
): Promise<{ workflows: Workflow[]; complete: boolean }> {
  const dir = join(top ?? project.root, ".github", "workflows");
  const listed = await project.list(dir);
  if (!listed.ok) {
    if (!listed.missing)
      project.unknown(
        "the secrets the workflows use",
        `${relative(project.root, dir)} couldn't be read: ${listed.reason}`,
      );
    return { workflows: [], complete: listed.missing };
  }
  const workflows: Workflow[] = [];
  let complete = true;
  for (const entry of listed.entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.kind !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
    const path = relative(project.root, join(dir, entry.name));
    const text = await project.read(path);
    const refs = text === null ? null : workflowRefs(text);
    if (refs) workflows.push({ path, refs });
    else if (text !== null) project.unknown(`the secrets ${path} uses`, "it isn't valid YAML");
    complete &&= refs !== null && !refs.hidesUses;
  }
  return { workflows, complete };
}

async function lookUp(
  project: ProjectReader,
  host: WorkflowHost,
  top: string | null,
  workflows: Workflow[],
  complete: boolean,
): Promise<Discovered> {
  for (const workflow of workflows)
    if (workflow.refs.hidesUses)
      project.unknown(
        `every secret ${workflow.path} uses`,
        "it passes secrets on (secrets: inherit or toJSON(secrets)) or names one by an expression (secrets[...]), so check can't tell which",
      );
  const uses = usesSecrets(workflows);
  const oidc = idTokenNotes(
    workflows,
    host.vaults.flatMap((vault) => vault.oidcVariables ?? []),
  );
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
    needs: (view) => needsOf(github, workflows, complete, view, oidc),
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

function idTokenNotes(workflows: readonly Workflow[], variables: readonly string[]): string[] {
  return workflows.flatMap(({ path, refs }) =>
    refs.jobs.flatMap((job) => {
      const set = variables.filter((name) => job.env.includes(name));
      if (!set.length || job.idToken !== false) return [];
      const fix = job.permissions?.map
        ? `add id-token: write to the ${job.permissions.at}'s permissions`
        : "grant id-token: write on the job (or workflow), keeping the permissions it needs";
      return [
        `${path}: job ${job.name} sets ${set.join(", ")} for keypin run, but its permissions don't grant id-token: write${job.directOnly ? " when the workflow runs directly rather than through workflow_call" : ""}; ${fix}`,
      ];
    }),
  );
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
