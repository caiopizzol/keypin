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
import { isRecord } from "./record";
import { formatReference } from "./reference";
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
  notes: string[];
}

interface Place {
  id: string;
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
    const found = needs.find((n) => n.need.name === name && n.place.id === place.id);
    if (found) {
      if (!found.need.usedBy.includes(usedBy)) found.need.usedBy.push(usedBy);
      return;
    }
    const candidates = (keys?.keys ?? []).filter((k) =>
      place.to === "github-actions" ? k.name.toUpperCase() === name : k.name === name,
    );
    const key =
      candidates.find((k) => mappedIn(keys, k, place) !== null) ??
      candidates.find((k) => k.name === name) ??
      candidates[0] ??
      null;
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
  const accounts = new Map<string, Set<string | null>>();
  for (const worker of scan.workers)
    if (worker.worker !== null)
      accounts.set(worker.worker, (accounts.get(worker.worker) ?? new Set()).add(worker.account));
  for (const worker of scan.workers) {
    const place = workerPlace(worker, (accounts.get(worker.worker ?? "")?.size ?? 0) > 1);
    for (const name of worker.required ?? []) need(name, place, worker.config);
  }

  const missing = needs.filter((n) => n.need.mapped === null);
  const add = tomlToAdd(missing, keys, environment, map?.text ?? "");

  const problems: string[] = [];
  const notes: string[] = [];
  for (const { need: n, place, key } of needs) {
    if (n.ok) continue;
    const uses = `${n.usedBy.join(", ")} ${n.to === "github-actions" ? "uses" : "requires"} it`;
    if (n.mapped !== null) {
      problems.push(
        `${n.name}: keypin.toml publishes it to ${place.label}, which doesn't have it yet; run keypin publish ${key?.name ?? n.name}${envFlag(n.mapped, environment)}`,
      );
      continue;
    }
    const held =
      n.holds === true
        ? `${place.label} has it, but keypin.toml doesn't publish it there`
        : n.holds === false
          ? `${place.label} doesn't have it${maybeEnvironment(place)}, and keypin.toml doesn't publish it there`
          : `keypin.toml doesn't publish it to ${place.label}`;
    const edit = add.edits.get(`${n.name} ${place.id}`);
    problems.push(`${n.name}: ${uses}; ${held}. ${edit ?? "Add the TOML below"}`);
  }
  if (repo.hidden && scan.github.read?.ok) {
    const unmapped = scan.github.read.secrets
      .map((s) => s.name)
      .filter(
        (name) =>
          !needs.some((n) => n.place.id === repo.id && n.need.name === name.toUpperCase()) &&
          !keys?.keys.some(
            (k) => k.name.toUpperCase() === name.toUpperCase() && mappedIn(keys, k, repo) !== null,
          ),
      );
    if (unmapped.length)
      notes.push(
        `${repo.label} has ${unmapped.join(", ")}, which no workflow names and keypin.toml doesn't publish there; a workflow that passes secrets on may use them`,
      );
  }

  const environments = keys?.environments ?? DEFAULT_ENVIRONMENTS;
  const run = runEnvironment({ environments });
  const local: LocalFile[] = [];
  for (const file of scan.envFiles) {
    if (file.kind !== "set") continue;
    const suffix = /^(?:\.env|\.dev\.vars)\.(.+)$/.exec(file.path.split("/").at(-1) ?? "")?.[1];
    const env = suffix !== undefined && environments.includes(suffix) ? suffix : run;
    const flag = envFlag(env, run);
    const names = file.names.filter(isVariableName);
    const key = (name: string) => keys?.keys.find((k) => k.name === name);
    const unmapped = names.filter((name) => !key(name));
    const elsewhere = names.filter((name) => {
      const found = key(name);
      return found !== undefined && !found.environments[env];
    });
    local.push({ file: file.path, tracked: file.tracked, unmapped, elsewhere });
    if (file.tracked)
      problems.push(`${file.path} is tracked by git, so its values may be committed`);
    if (unmapped.length) {
      const account = keys?.account ? "" : ` --account ${PLACEHOLDER.account}`;
      notes.push(
        `${file.path} sets ${unmapped.join(", ")}, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import ${file.path} NAME...${flag} --vault ${PLACEHOLDER.vault}${account}`,
      );
    }
    if (elsewhere.length)
      problems.push(
        `${file.path} sets ${elsewhere.join(", ")}, which keypin.toml maps with no ${env} entry; for a key run keypin import ${file.path} ${elsewhere.join(" ")}${flag} --vault ${PLACEHOLDER.vault}`,
      );
  }

  return {
    production: needs.map((n) => n.need),
    local,
    add: add.text,
    problems,
    notes,
  };
}

function mappedIn(map: KeysMap | null, key: KeyEntry | null, place: Place): Environment | null {
  if (!key) return null;
  for (const environment of map?.environments ?? []) {
    if (key.environments[environment]?.publish.some(place.covers)) return environment;
  }
  return null;
}

function githubPlace(scan: ProjectScan): Place & { hidden: boolean } {
  const repo = scan.github.repo;
  const read = scan.github.read;
  const held = read?.ok ? new Set(read.secrets.map((s) => s.name.toUpperCase())) : null;
  return {
    id: `github-actions:${repo?.toLowerCase() ?? ""}`,
    hidden: scan.workflows.some((w) => w.refs.hidesUses),
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

function workerPlace(worker: ProjectScan["workers"][number], ambiguous: boolean): Place {
  const held = worker.read?.ok ? new Set(worker.read.secrets.map((s) => s.name)) : null;
  const name = worker.worker;
  const where = `${worker.config}${worker.env ? ` (env ${worker.env})` : ""}`;
  const account = ambiguous ? ` in account ${worker.account ?? `unknown (${worker.config})`}` : "";
  return {
    id: `cloudflare-worker:${worker.account ?? (ambiguous ? where : "")}:${name ?? where}`,
    to: "cloudflare-worker",
    label: `the Worker ${name === null ? `in ${where}` : `${name}${account}`}`,
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
): { text: string | null; edits: Map<string, string> } {
  const blocks: string[][] = [];
  const edits = new Map<string, string>();
  for (const name of new Set(needs.map((n) => n.need.name))) {
    const all = needs.filter((n) => n.need.name === name);
    const key = all[0]?.key ?? null;
    const id = key?.name ?? name;
    const workers = new Map<string, string>();
    for (const target of key?.environments[environment]?.publish ?? [])
      if (target.to === "cloudflare-worker") workers.set(target.worker, target.account);
    const found = all.filter(({ place }) => {
      const worker = fieldOf(place, "worker");
      const account = fieldOf(place, "account");
      if (place.to !== "cloudflare-worker" || worker === null || worker === PLACEHOLDER.worker)
        return true;
      const taken = workers.get(worker);
      if (taken === undefined) {
        workers.set(worker, account ?? "");
        return true;
      }
      edits.set(
        `${name} ${place.id}`,
        `keypin.toml can't publish ${id} to two Workers named ${worker} from one environment (accounts ${taken} and ${account}); publish one of them from another environment, listed in environments`,
      );
      return false;
    });
    if (!found.length) continue;
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
      const edit = inlineEdit(
        text,
        key,
        environment,
        found.map((f) => f.place),
      );
      for (const { place } of found) edits.set(`${name} ${place.id}`, edit);
      continue;
    }
    blocks.push(...own);
  }
  if (!blocks.length) return { text: null, edits };
  if (!map?.account) blocks.unshift(["[1password]", `account = ${str(PLACEHOLDER.account)}`]);
  return { text: `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`, edits };
}

function inlineEdit(
  text: string,
  key: KeyEntry,
  environment: Environment,
  places: readonly Place[],
): string {
  const entries = places.map(
    (place) => `{ ${place.fields.map(([field, value]) => `${field} = ${str(value)}`).join(", ")} }`,
  );
  const list = `publish = [${entries.join(", ")}]`;
  const entry = key.environments[environment];
  const at = `[keys.${key.name}]`;
  if (!entry)
    return `Add ${environment} = { from = ${str(PLACEHOLDER.from)}, ${list} } to ${at} in keypin.toml`;
  const from = `from = ${str(formatReference(entry.ref))}`;
  const raw = rawEntry(text, key.name, environment);
  if (typeof raw === "string")
    return `In ${at} in keypin.toml, replace ${environment} = ${str(raw)} with ${environment} = { ${from}, ${list} }`;
  if (isRecord(raw) && Array.isArray(raw.publish))
    return `Add ${entries.join(" and ")} to the publish list of ${environment} in ${at} in keypin.toml`;
  return `In ${at} in keypin.toml, replace the ${environment} entry with ${environment} = { ${from}, ${list} }`;
}

function rawEntry(text: string, name: string, environment: Environment): unknown {
  try {
    const data = parseToml(text);
    const key = isRecord(data.keys) ? data.keys[name] : undefined;
    return isRecord(key) ? key[environment] : undefined;
  } catch {
    return undefined;
  }
}

function appends(text: string, blocks: readonly string[][]): boolean {
  try {
    parseToml(`${text}\n${blocks.map((block) => block.join("\n")).join("\n\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

function fieldOf(place: Place, field: string): string | null {
  return place.fields.find(([name]) => name === field)?.[1] ?? null;
}

function str(value: string): string {
  return JSON.stringify(value);
}
