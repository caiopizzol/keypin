import { parse as parseToml } from "smol-toml";
import type { Environment } from "./contracts";
import { DEFAULT_ENVIRONMENTS } from "./contracts";
import {
  envFlag,
  isEnvironmentName,
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
  github: {
    repo: string | null;
    read: StoreRead | null;
    environments: { name: string; read: StoreRead }[];
  };
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

export type Fix =
  | { kind: "environments"; text: string; why: string; at: string; line: string }
  | { kind: "tracked"; text: string; file: string }
  | {
      kind: "import";
      text: string;
      why: string;
      file: string;
      names: string[];
      options: string;
      caveat: string | null;
    }
  | { kind: "add"; text: string; why: string }
  | { kind: "edit"; text: string }
  | { kind: "publish"; text: string; key: string; why: string; command: string };

export interface Gaps {
  production: Need[];
  local: LocalFile[];
  add: string | null;
  problems: string[];
  notes: string[];
  fixes: Fix[];
}

interface Place {
  id: string;
  to: PublishTarget["to"];
  label: string;
  fields: [string, string][];
  covers: (target: PublishTarget) => boolean;
  holds: (name: string) => boolean | null;
  onlyFrom: readonly Environment[];
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
  const listed = keys?.environments ?? DEFAULT_ENVIRONMENTS;
  const environment = publishEnvironment({ environments: listed });
  const notes: string[] = [];
  const needs: Found[] = [];
  const need = (name: string, place: Place, usedBy: string) => {
    if (!isVariableName(name)) return;
    const found = needs.find((n) => n.need.name === name && n.place.id === place.id);
    if (found) {
      if (!found.need.usedBy.includes(usedBy)) found.need.usedBy.push(usedBy);
      return;
    }
    needs.push(resolve(name, place, [usedBy]));
  };
  const resolve = (name: string, place: Place, usedBy: string[]): Found => {
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
    return {
      place,
      key,
      need: {
        name,
        to: place.to,
        place: place.label,
        usedBy,
        mapped,
        holds,
        ok: mapped !== null && holds !== false,
      },
    };
  };

  const repo = githubPlace(scan, null);
  const uses = scan.workflows.flatMap((workflow) =>
    workflow.refs.uses.flatMap(({ environment, secrets }) =>
      secrets
        .filter((name) => !name.startsWith("GITHUB_"))
        .map((name) => ({ name, path: workflow.path, environment })),
    ),
  );
  const declared = new Map<string, Set<string>>();
  for (const use of uses) {
    const literal = literalEnvironment(use.environment);
    const environment = literal === null ? null : githubPlace(scan, literal);
    const alone = uses
      .filter((u) => u.name === use.name)
      .every((u) => literalEnvironment(u.environment)?.toLowerCase() === literal?.toLowerCase());
    const place =
      environment !== null &&
      (publishes(keys, use.name, environment) ||
        (alone && !publishes(keys, use.name, repo) && repo.holds(use.name) === false))
        ? environment
        : repo;
    if (place === repo && use.environment !== null)
      declared.set(use.name, (declared.get(use.name) ?? new Set()).add(use.environment));
    need(use.name, place, use.path);
  }
  const accounts = new Map<string, Set<string | null>>();
  for (const worker of scan.workers)
    if (worker.worker !== null)
      accounts.set(worker.worker, (accounts.get(worker.worker) ?? new Set()).add(worker.account));
  const places = scan.workers.map((worker) =>
    workerPlace(worker, (accounts.get(worker.worker ?? "")?.size ?? 0) > 1),
  );
  const declaredBy = new Map<string, Set<Environment>>();
  scan.workers.forEach((worker, i) => {
    const id = places[i]?.id ?? "";
    if (!declaredBy.has(id)) declaredBy.set(id, new Set());
    if (worker.env !== null && isEnvironmentName(worker.env)) declaredBy.get(id)?.add(worker.env);
  });
  for (const [i, worker] of scan.workers.entries()) {
    const base = places[i];
    if (!base) continue;
    const place = { ...base, onlyFrom: [...(declaredBy.get(base.id) ?? [])].sort() };
    if (worker.env !== null && !isEnvironmentName(worker.env) && worker.required?.length)
      notes.push(
        `${worker.config} env ${worker.env} isn't a keypin environment name, so check proposes its Worker under ${environment}; publish it from the environment that holds its value`,
      );
    for (const name of worker.required ?? []) need(name, place, worker.config);
  }

  for (const [id, envs] of declaredBy) {
    const label = needs.find((n) => n.place.id === id)?.place.label;
    if (envs.size < 2 || label === undefined) continue;
    notes.push(
      `${label} is declared by the wrangler envs ${[...envs].sort().join(" and ")}; it holds one value, so check accepts it from any of them. Give each env its own Worker name to check them apart`,
    );
  }

  const elsewhere = (found: Found) =>
    found.place.onlyFrom.length
      ? mappedIn(keys, found.key, { ...found.place, onlyFrom: [] })
      : null;
  const missing = needs.filter((n) => n.need.mapped === null && elsewhere(n) === null);
  const add = tomlToAdd(missing, keys, environment, map?.text ?? "");

  const problems: string[] = [];
  const fixes: Fix[] = [];
  const fix = (found: Fix) => {
    fixes.push(found);
    problems.push(found.text);
  };
  const unlisted = [
    ...new Set(
      needs.flatMap(({ need: n, place }) => {
        const env = proposedIn(place, environment);
        return n.mapped === null && !listed.includes(env) ? [env] : [];
      }),
    ),
  ];
  if (unlisted.length) {
    const order =
      listed.length > 1
        ? [...listed.slice(0, -1), ...unlisted, environment]
        : [...listed, ...unlisted];
    const line = `environments = ${JSON.stringify(order).replaceAll(",", ", ")}`;
    const at = hasEnvironments(map?.text ?? "")
      ? "replace the environments line in keypin.toml with"
      : "add at the top of keypin.toml";
    const why = `keypin.toml has no environment for the wrangler env${unlisted.length > 1 ? "s" : ""} ${unlisted.join(" and ")}`;
    fix({
      kind: "environments",
      text: `${why}; ${at}: ${line} (keypin run uses the first, keypin publish the last)`,
      why,
      at,
      line,
    });
  }
  for (const found of needs) {
    const { need: n, place, key } = found;
    if (n.ok) continue;
    const uses = `${n.usedBy.join(", ")} ${n.to === "github-actions" ? "uses" : "requires"} it`;
    const other = elsewhere(found);
    if (other !== null && n.mapped === null) {
      const why = `${n.name}: ${uses}`;
      const edit = `keypin.toml publishes it to ${place.label} from ${other}, but that Worker is the wrangler env ${place.onlyFrom.join(" and ")}, so it would get the ${other} value; move that publish entry to ${place.onlyFrom.join(" or ")}`;
      fix({ kind: "edit", text: `${why}; ${edit}` });
      continue;
    }
    if (n.mapped !== null) {
      const why = `${n.name}: keypin.toml publishes it to ${place.label}, which doesn't have it yet`;
      const name = key?.name ?? n.name;
      const command = `keypin publish ${name}${envFlag(n.mapped, environment)}`;
      fix({ kind: "publish", text: `${why}; run ${command}`, key: name, why, command });
      continue;
    }
    const held =
      n.holds === true
        ? `${place.label} has it, but keypin.toml doesn't publish it there`
        : n.holds === false
          ? `${place.label} doesn't have it${maybeEnvironment(place === repo ? [...(declared.get(n.name) ?? [])] : [])}, and keypin.toml doesn't publish it there`
          : `keypin.toml doesn't publish it to ${place.label}`;
    const why = `${n.name}: ${uses}; ${held}`;
    const edit = add.edits.get(`${n.name} ${place.id}`);
    fix(
      edit === undefined
        ? { kind: "add", text: `${why}. Add the TOML below`, why }
        : { kind: "edit", text: `${why}. ${edit}` },
    );
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
    const caveat =
      suffix !== undefined &&
      !environments.includes(suffix) &&
      isEnvironmentName(suffix) &&
      !/^(local|dev|development)$/.test(suffix)
        ? `maps them as ${run}; if they're the values of another environment, list it in environments and add --env <name>`
        : null;
    const other = caveat === null ? "" : `, which ${caveat}`;
    const names = file.names.filter(isVariableName);
    const key = (name: string) => keys?.keys.find((k) => k.name === name);
    const unmapped = names.filter((name) => !key(name));
    const elsewhere = names.filter((name) => {
      const found = key(name);
      return found !== undefined && !found.environments[env];
    });
    local.push({ file: file.path, tracked: file.tracked, unmapped, elsewhere });
    if (file.tracked)
      fix({
        kind: "tracked",
        text: `${file.path} is tracked by git, so its values may be committed`,
        file: file.path,
      });
    const importing = (why: string, names: string[], account: string) => ({
      kind: "import" as const,
      why,
      file: file.path,
      names,
      options: `${flag} --vault ${PLACEHOLDER.vault}${account}`,
      caveat: caveat && `That command ${caveat}`,
    });
    if (unmapped.length) {
      const account = keys?.account ? "" : ` --account ${PLACEHOLDER.account}`;
      const sets = `${file.path} sets ${unmapped.join(", ")}, which keypin.toml doesn't map`;
      const found = importing(sets, unmapped, account);
      const text = `${sets}; a plain setting can stay, and for a key run keypin import ${file.path} NAME...${found.options}${other}`;
      notes.push(text);
      fixes.push({ ...found, text });
    }
    if (elsewhere.length) {
      const why = `${file.path} sets ${elsewhere.join(", ")}, which keypin.toml maps with no ${env} entry`;
      const found = importing(why, elsewhere, "");
      fix({
        ...found,
        text: `${why}; for a key run keypin import ${file.path} ${elsewhere.join(" ")}${found.options}${other}`,
      });
    }
  }

  return {
    production: needs.map((n) => n.need),
    local,
    add: add.text,
    problems,
    notes,
    fixes,
  };
}

function mappedIn(map: KeysMap | null, key: KeyEntry | null, place: Place): Environment | null {
  if (!key) return null;
  for (const environment of map?.environments ?? []) {
    if (place.onlyFrom.length && !place.onlyFrom.includes(environment)) continue;
    if (key.environments[environment]?.publish.some(place.covers)) return environment;
  }
  return null;
}

function literalEnvironment(environment: string | null): string | null {
  return environment === null || environment.includes("${{") ? null : environment;
}

function publishes(map: KeysMap | null, name: string, place: Place): boolean {
  return (map?.keys ?? []).some(
    (k) => k.name.toUpperCase() === name && mappedIn(map, k, place) !== null,
  );
}

function githubPlace(scan: ProjectScan, environment: string | null): Place & { hidden: boolean } {
  const repo = scan.github.repo;
  const env = environment?.toLowerCase();
  const read =
    env === undefined
      ? scan.github.read
      : scan.github.environments.find((e) => e.name.toLowerCase() === env)?.read;
  const held = read?.ok ? new Set(read.secrets.map((s) => s.name.toUpperCase())) : null;
  const fields: [string, string][] = [
    ["to", "github-actions"],
    ["repo", repo ?? PLACEHOLDER.repo],
  ];
  if (environment !== null) fields.push(["environment", environment]);
  return {
    id: `github-actions:${repo?.toLowerCase() ?? ""}${env === undefined ? "" : `/environments/${env}`}`,
    hidden: scan.workflows.some((w) => w.refs.hidesUses),
    to: "github-actions",
    label: `${repo ?? "the GitHub repository"}${environment === null ? "" : ` (environment ${environment})`}`,
    fields,
    covers: (target) =>
      target.to === "github-actions" &&
      (repo === null || target.repo.toLowerCase() === repo.toLowerCase()) &&
      target.environment?.toLowerCase() === env,
    holds: (name) => (held ? held.has(name.toUpperCase()) : null),
    onlyFrom: [],
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
    onlyFrom: [],
  };
}

function proposedIn(place: Place, publish: Environment): Environment {
  return place.onlyFrom.length && !place.onlyFrom.includes(publish)
    ? (place.onlyFrom[0] ?? publish)
    : publish;
}

function hasEnvironments(text: string): boolean {
  try {
    return parseToml(text).environments !== undefined;
  } catch {
    return false;
  }
}

function maybeEnvironment(environments: readonly string[]): string {
  return environments.length
    ? ` as a repo secret (it may be a secret of the environment ${environments.join(" or ")}, which check doesn't read)`
    : "";
}

function tomlToAdd(
  needs: readonly Found[],
  map: KeysMap | null,
  publish: Environment,
  text: string,
): { text: string | null; edits: Map<string, string> } {
  const blocks: string[][] = [];
  const edits = new Map<string, string>();
  const groups = new Map<string, Found[]>();
  for (const found of needs) {
    const group = `${found.need.name} ${proposedIn(found.place, publish)}`;
    groups.set(group, [...(groups.get(group) ?? []), found]);
  }
  const started = new Set<string>();
  for (const all of groups.values()) {
    const name = all[0]?.need.name ?? "";
    const environment = all[0] ? proposedIn(all[0].place, publish) : publish;
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
    if (!key && !started.has(id)) own.push([`[keys.${id}]`, `rotate_every = ${str(ROTATE_EVERY)}`]);
    started.add(id);
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
