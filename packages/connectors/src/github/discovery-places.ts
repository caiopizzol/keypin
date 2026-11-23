import type { MapView, Place, StoreRead } from "@keypin/core";
import type { Repo } from "./discovery-repo";

const REPO_PLACEHOLDER = "<owner>/<repo>";

export function githubPlace(
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

export function namesOf(read: StoreRead | null): Set<string> | null {
  return read?.ok ? new Set(read.secrets.map((s) => s.name.toUpperCase())) : null;
}

function maybeEnvironment(environments: readonly string[]): string {
  return environments.length
    ? ` as a repo secret (it may be a secret of the environment ${environments.join(" or ")}, which check doesn't read)`
    : "";
}

export function literalEnvironment(environment: string | null): string | null {
  return environment === null || environment.includes("${{") ? null : environment;
}
