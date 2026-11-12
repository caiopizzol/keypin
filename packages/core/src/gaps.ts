import { parse as parseToml } from "smol-toml";
import type { Environment } from "./contracts";
import { DEFAULT_ENVIRONMENTS } from "./contracts";
import {
  envFlag,
  isVariableName,
  type KeyEntry,
  type KeysMap,
  publishEnvironment,
  type PublishTarget,
  runEnvironment,
} from "./map";
import type { EnvFileKind, StoreRead, WorkerDeclaration, WorkflowRefs } from "./scan";

export interface ProjectScan {
  envFiles: { path: string; kind: EnvFileKind; names: string[]; tracked: boolean | null }[];
  workflows: { path: string; refs: WorkflowRefs }[];
  workers: (WorkerDeclaration & { read: StoreRead | null })[];
  github: { repo: string | null; read: StoreRead | null };
}

export interface Need {
  name: string;
  to: PublishTarget["to"];
  place: string;
  usedBy: string[];
  mapped: Environment | null;
  holds: boolean | null;
  ok: boolean;
}

export interface LocalFile {
  file: string;
  tracked: boolean | null;
  unmapped: string[];
  elsewhere: string[];
}

export interface Gaps {
  production: Need[];
  local: LocalFile[];
  add: string | null;
  problems: string[];
}

interface Place {
  to: PublishTarget["to"];
  label: string;
  fields: [string, string][];
  covers: (target: PublishTarget) => boolean;
  holds: (name: string) => boolean | null;
  environments: string[];
}

const PLACEHOLDER = {
  account: "<1Password sign-in address>",
  from: "op://<vault>/<item>/<field>",
  repo: "<owner>/<repo>",
  cloudflare: "<Cloudflare account ID>",
  worker: "<Worker name>",
  vault: "<vault>",
};

const ROTATE_EVERY = "90d";

interface Found {
  need: Need;
  place: Place;
  key: KeyEntry | null;
}

export function findGaps(scan: ProjectScan, map: { map: KeysMap; text: string } | null): Gaps {
  const keys = map?.map ?? null;
  const environment = publishEnvironment(keys ?? { environments: DEFAULT_ENVIRONMENTS });
  const needs: Found[] = [];
  const need = (name: string, place: Place, usedBy: string) => {
    if (!isVariableName(name)) return;
    const found = needs.find((n) => n.need.name === name && n.place.label === place.label);
    if (found) {
      if (!found.need.usedBy.includes(usedBy)) found.need.usedBy.push(usedBy);
      return;
    }
    const key =
      keys?.keys.find((k) =>
        place.to === "github-actions" ? k.name.toUpperCase() === name : k.name === name,
      ) ?? null;
    const mapped = mappedIn(keys, key, place);
    const holds = place.holds(name);
    needs.push({
      place,
      key,
      need: {
        name,
        to: place.to,
        place: place.label,
        usedBy: [usedBy],
        mapped,
        holds,
        ok: mapped !== null && holds !== false,
      },
    });
  };

  const repo = githubPlace(scan);
  for (const workflow of scan.workflows) {
    for (const name of workflow.refs.secrets) {
      if (name.startsWith("GITHUB_")) continue;
      need(name, repo, workflow.path);
    }
  }
  for (const worker of scan.workers) {
    const place = workerPlace(worker);
    for (const name of worker.required ?? []) need(name, place, worker.config);
  }

  const missing = needs.filter((n) => n.need.mapped === null);
  const add = tomlToAdd(missing, keys, environment, map?.text ?? "");

  const problems: string[] = [];
  for (const { need: n, place } of needs) {
    if (n.ok) continue;
    const uses = `${n.usedBy.join(", ")} ${n.to === "github-actions" ? "uses" : "requires"} it`;
    if (n.mapped !== null) {
      problems.push(
        `${n.name}: keypin.toml publishes it to ${place.label}, which doesn't have it yet; run keypin publish ${n.name}${envFlag(n.mapped, environment)}`,
      );
      continue;
    }
    const held =
      n.holds === true
        ? `${place.label} has it, but keypin.toml doesn't publish it there`
        : n.holds === false
          ? `${place.label} doesn't have it${maybeEnvironment(place)}, and keypin.toml doesn't publish it there`
          : `keypin.toml doesn't publish it to ${place.label}`;
    const inline = add.inline.get(`${n.name} ${place.label}`);
    problems.push(
      `${n.name}: ${uses}; ${held}. ${inline ? `Add ${inline} to its publish list in keypin.toml` : "Add the TOML below"}`,
    );
  }

  const run = runEnvironment(keys ?? { environments: DEFAULT_ENVIRONMENTS });
  const local: LocalFile[] = [];
  for (const file of scan.envFiles) {
    if (file.kind !== "set") continue;
    const names = file.names.filter(isVariableName);
    const key = (name: string) => keys?.keys.find((k) => k.name === name);
    const unmapped = names.filter((name) => !key(name));
    const elsewhere = names.filter((name) => {
      const found = key(name);
      return found !== undefined && !found.environments[run];
    });
    local.push({ file: file.path, tracked: file.tracked, unmapped, elsewhere });
    if (file.tracked)
      problems.push(`${file.path} is tracked by git, so its values may be committed`);
    if (unmapped.length) {
      const account = keys?.account ? "" : ` --account ${PLACEHOLDER.account}`;
      problems.push(
        `${file.path} sets ${unmapped.join(", ")}, which keypin.toml doesn't map; run keypin import ${file.path} --vault ${PLACEHOLDER.vault}${account}`,
      );
    }
    if (elsewhere.length)
      problems.push(
        `${file.path} sets ${elsewhere.join(", ")}, which keypin.toml maps with no ${run} entry; add a ${run} reference to each by hand`,
      );
  }

  return {
    production: needs.map((n) => n.need),
    local,
    add: add.text,
    problems,
  };
}

function mappedIn(map: KeysMap | null, key: KeyEntry | null, place: Place): Environment | null {
  if (!key) return null;
  for (const environment of map?.environments ?? []) {
    if (key.environments[environment]?.publish.some(place.covers)) return environment;
  }
  return null;
}

function githubPlace(scan: ProjectScan): Place {
  const repo = scan.github.repo;
  const read = scan.github.read;
  const held = read?.ok ? new Set(read.secrets.map((s) => s.name.toUpperCase())) : null;
  return {
    to: "github-actions",
    label: repo ?? "the GitHub repository",
    fields: [
      ["to", "github-actions"],
      ["repo", repo ?? PLACEHOLDER.repo],
    ],
    covers: (target) =>
      target.to === "github-actions" &&
      (repo === null || target.repo.toLowerCase() === repo.toLowerCase()),
    holds: (name) => (held ? held.has(name.toUpperCase()) : null),
    environments: [...new Set(scan.workflows.flatMap((w) => w.refs.environments))],
  };
}

function workerPlace(worker: ProjectScan["workers"][number]): Place {
  const held = worker.read?.ok ? new Set(worker.read.secrets.map((s) => s.name)) : null;
  const name = worker.worker;
  return {
    to: "cloudflare-worker",
    label: `the Worker ${name ?? `in ${worker.config}${worker.env ? ` (env ${worker.env})` : ""}`}`,
    fields: [
      ["to", "cloudflare-worker"],
      ["account", worker.account ?? PLACEHOLDER.cloudflare],
      ["worker", name ?? PLACEHOLDER.worker],
    ],
    covers: (target) =>
      target.to === "cloudflare-worker" &&
      name !== null &&
      target.worker === name &&
      (worker.account === null || target.account === worker.account),
    holds: (secret) => (held ? held.has(secret) : null),
    environments: [],
  };
}

function maybeEnvironment(place: Place): string {
  return place.environments.length
    ? ` as a repo secret (it may be a secret of the environment ${place.environments.join(" or ")}, which check doesn't read)`
    : "";
}

function tomlToAdd(
  needs: readonly Found[],
  map: KeysMap | null,
  environment: Environment,
  text: string,
): { text: string | null; inline: Map<string, string> } {
  const blocks: string[][] = [];
  const inline = new Map<string, string>();
  for (const name of new Set(needs.map((n) => n.need.name))) {
    const found = needs.filter((n) => n.need.name === name);
    const key = found[0]?.key ?? null;
    const id = key?.name ?? name;
    const own: string[][] = [];
    if (!key) own.push([`[keys.${id}]`, `rotate_every = ${str(ROTATE_EVERY)}`]);
    if (!key?.environments[environment])
      own.push([`[keys.${id}.${environment}]`, `from = ${str(PLACEHOLDER.from)}`]);
    for (const { place } of found)
      own.push([
        `[[keys.${id}.${environment}.publish]]`,
        ...place.fields.map(([field, value]) => `${field} = ${str(value)}`),
      ]);
    if (key && !appends(text, own)) {
      for (const { place } of found)
        inline.set(
          `${name} ${place.label}`,
          `{ ${place.fields.map(([field, value]) => `${field} = ${str(value)}`).join(", ")} }`,
        );
      continue;
    }
    blocks.push(...own);
  }
  if (!blocks.length) return { text: null, inline };
  if (!map?.account) blocks.unshift(["[1password]", `account = ${str(PLACEHOLDER.account)}`]);
  return { text: `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`, inline };
}

function appends(text: string, blocks: readonly string[][]): boolean {
  try {
    parseToml(`${text}\n${blocks.map((block) => block.join("\n")).join("\n\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

function str(value: string): string {
  return JSON.stringify(value);
}
