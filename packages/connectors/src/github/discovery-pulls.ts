import { type MapView, shellWord } from "@keypin/core";
import type { KeypinRun } from "./workflows";
import { describePlace, literalEnvironment, placeOf } from "./discovery-places";
import type { PulledAt, Repo, Workflow } from "./discovery-repo";

export function reaches(pulled: PulledAt, jobEnvironment: string | null): boolean {
  if (pulled.environment === null) return true;
  return literalEnvironment(jobEnvironment)?.toLowerCase() === pulled.environment.toLowerCase();
}

export function leftovers(
  github: Repo,
  references: ReadonlyMap<PulledAt, string[]>,
  complete: boolean,
): string[] {
  const problems = new Map<string, string>();
  for (const pulled of github.pulled) {
    const { key, environment } = pulled.pulled;
    const where = `${key} ${placeOf(pulled.repo, pulled.environment)}`;
    if (problems.has(where)) continue;
    const group = github.pulled.filter(
      (p) => `${p.pulled.key} ${placeOf(p.repo, p.environment)}` === where,
    );
    const place = describePlace(pulled.repo, pulled.environment);
    const publishedIn = [...new Set(group.flatMap((p) => p.pulled.publishedIn))];
    if (publishedIn.length) {
      problems.set(
        where,
        `${key}: keypin.toml says jobs in ${place} pull it from the vault at job time, but also publishes it there for ${publishedIn.join(" and ")}; keep the pull entry or the publish entry, not both`,
      );
      continue;
    }
    const paths = group.flatMap((p) => references.get(p) ?? []);
    const stored =
      pulled.read.ok && pulled.read.secrets.some((s) => s.name.toUpperCase() === key.toUpperCase());
    if (!stored && !paths.length) continue;
    const secret = `secrets.${key.toUpperCase()}`;
    const facts = [
      ...(paths.length
        ? [`${paths.join(", ")} still ${paths.length === 1 ? "uses" : "use"} ${secret}`]
        : []),
      ...(stored ? [`${place} still has it as an Actions secret`] : []),
    ];
    const remove = `gh secret delete ${key} --repo ${pulled.repo}${pulled.environment === null ? "" : ` --env ${shellWord(pulled.environment)}`}`;
    const origin = github.repo !== null && pulled.repo.toLowerCase() === github.repo.toLowerCase();
    const unread = !origin
      ? `check can't read the workflows of ${pulled.repo}`
      : !complete
        ? `check can't tell which secrets every workflow of ${pulled.repo} uses`
        : null;
    const fixes = [
      ...(paths.length
        ? [`read it with keypin run --env ${environment} --only ${key} -- <command> instead`]
        : []),
      ...(stored
        ? [
            unread === null
              ? `delete the Actions secret: ${remove}`
              : `${unread}, so it can't tell whether one still uses ${secret}; once none does, delete the Actions secret: ${remove}`,
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

export function pullNotes(
  repo: string | null,
  here: readonly PulledAt[],
  workflows: readonly Workflow[],
  view: MapView,
): string[] {
  if (repo === null || !workflows.length) return [];
  const keypinEnv = (run: KeypinRun) => (run.dynamicEnv ? null : (run.env ?? view.runEnvironment));
  const covers = (pulled: PulledAt, run: KeypinRun) => {
    const env = keypinEnv(run);
    return reaches(pulled, run.environment) && (env === null || env === pulled.pulled.environment);
  };
  const notes = new Set<string>();
  for (const { path, refs } of workflows)
    for (const run of refs.runs) {
      const env = keypinEnv(run);
      if (env === null) continue;
      for (const key of run.only ?? []) {
        if (here.some((p) => p.pulled.key === key && covers(p, run))) continue;
        const literal = literalEnvironment(run.environment);
        const fields = [`by = "github-actions"`, `repo = "${repo}"`];
        if (literal !== null) fields.push(`environment = "${literal}"`);
        notes.add(
          `${key}: ${path} reads it with keypin run, but keypin.toml has no pull entry for ${describePlace(repo, literal)}; add [[keys.${key}.${env}.pull]] with ${fields.join(", ")}`,
        );
      }
    }
  for (const pulled of here) {
    const { key } = pulled.pulled;
    const used = workflows.some(({ refs }) =>
      refs.runs.some((run) => covers(pulled, run) && (run.only?.includes(key) ?? true)),
    );
    if (!used)
      notes.add(
        `${key}: keypin.toml says jobs in ${describePlace(pulled.repo, pulled.environment)} pull it, but no workflow there runs keypin run for it`,
      );
  }
  return [...notes];
}
