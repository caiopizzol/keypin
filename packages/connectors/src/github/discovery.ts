import { join, relative } from "node:path";
import { type Discovered, type Discovery, messageOf, type ProjectReader } from "@keypin/core";
import { usesSecrets, workflowRefs } from "./workflows";
import { needsOf } from "./discovery-needs";
import { githubOrigin } from "./discovery-origin";
import type { Repo, Workflow, WorkflowHost } from "./discovery-repo";

export type { WorkflowHost } from "./discovery-repo";

export const workflowDiscovery: Discovery<WorkflowHost> = {
  files: { key: "workflows", noun: "workflow" },
  async scan(project, host) {
    const top = (await host.git(project.root, ["rev-parse", "--show-toplevel"]))?.trim() || null;
    const workflows = await readWorkflows(project, top);
    return { finish: () => lookUp(project, host, top, workflows) };
  },
  async readers(project, host, profile) {
    const top = (await host.git(project.root, ["rev-parse", "--show-toplevel"]))?.trim() || null;
    return (await readWorkflows(project, top))
      .filter((workflow) => workflow.refs.secretspec.includes(profile))
      .map((workflow) => ({ file: workflow.path, how: `secretspec run --profile ${profile}` }));
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
    const refs = text === null ? null : workflowRefs(text);
    if (refs) workflows.push({ path, refs });
    else if (text !== null) project.unknown(`the secrets ${path} uses`, "it isn't valid YAML");
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
  return {
    files: workflows.map((w) => w.path),
    used: uses,
    about: github.repo ? `GitHub ${github.repo}` : null,
    report: { github: { repo: github.repo, login } },
    needs: (view) => needsOf(github, workflows, view),
  };
}

async function configuredLogin(host: WorkflowHost, project: ProjectReader) {
  return (await host.git(project.root, ["config", "--get", "github.account"]))?.trim() || null;
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
