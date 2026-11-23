import type { FoundNeed, MapView } from "@keypin/core";
import { githubPlace, literalEnvironment, namesOf } from "./discovery-places";
import type { Repo, Workflow } from "./discovery-repo";

export function needsOf(github: Repo, workflows: Workflow[], view: MapView) {
  const declared = new Map<string, Set<string>>();
  const repo = githubPlace(github, null, declared, view);
  const uses = workflows.flatMap((workflow) =>
    workflow.refs.uses.flatMap(({ environment, secrets, fromCaller, secretspec }) =>
      secrets
        .filter((name) => !name.startsWith("GITHUB_"))
        .map((name) => ({ name, path: workflow.path, environment, fromCaller, secretspec })),
    ),
  );
  const required = uses.filter((use) => !use.fromCaller);
  const needs: FoundNeed[] = [];
  const shared = namesOf(github.organization);
  const fromOrganization = new Map<string, { paths: string[]; environments: string[] }>();
  const readAtJobTime: { name: string; path: string; profile: string }[] = [];
  for (const use of uses) {
    if (view.ignores(use.name)) {
      needs.push({ name: use.name, place: repo, usedBy: use.path });
      continue;
    }
    const profile = use.secretspec.find((p) => p !== null && view.declares(use.name, p));
    if (profile) {
      if (!readAtJobTime.some((r) => r.name === use.name && r.path === use.path))
        readAtJobTime.push({ name: use.name, path: use.path, profile });
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
    notes: [
      ...readAtJobTime.map(
        ({ name, path, profile }) =>
          `${name}: ${path} runs secretspec run, which reads it from the ${profile} profile's vault at job time, so ${repo.label} doesn't need it; the job's secrets.${name} can go`,
      ),
      ...[...fromOrganization].map(
        ([name, { paths, environments }]) =>
          `${name}: ${paths.join(", ")} uses it; ${repo.label} has it (org secret), which secretspec.toml doesn't publish${
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
            !view.ignores(name),
        );
      return unmapped.length
        ? [
            `${repo.label} has ${unmapped.join(", ")}, which no workflow names and secretspec.toml doesn't publish there; a workflow that passes secrets on may use them`,
          ]
        : [];
    },
  };
}
