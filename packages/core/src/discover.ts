import { TOML } from "bun";
import type { Environment } from "./contracts";
import { DEFAULT_ENVIRONMENTS } from "./contracts";
import { type KeysMap, publishEnvironment, runEnvironment } from "./map";
import { isRecord } from "./record";

export type EnvFileKind = "set" | "expected";

export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".wrangler",
  "dist",
  "build",
  "out",
  ".output",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".turbo",
  ".vercel",
  ".netlify",
  ".cache",
  ".parcel-cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  "Pods",
  "DerivedData",
]);

const ENV_FILE = /^(\.env|\.dev\.vars)(\..+)?$/;
const EXPECTED_FILE = /\.(example|sample|template)$/;

export function envFileKind(fileName: string): EnvFileKind | null {
  if (!ENV_FILE.test(fileName)) return null;
  return EXPECTED_FILE.test(fileName) ? "expected" : "set";
}

export const WRANGLER_FILES: readonly string[] = [
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
];

const DOTENV_LINE =
  /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;

export function envNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.replace(/\r\n?/g, "\n").matchAll(DOTENV_LINE)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

export interface WorkflowRefs {
  secrets: string[];
  vars: string[];
  environments: string[];
  hidesUses: boolean;
}

const CONTEXT_REF =
  /(?<![\w.])(secrets|vars)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\])/g;

export function workflowRefs(text: string): WorkflowRefs | null {
  let data: unknown;
  try {
    data = Bun.YAML.parse(text);
  } catch {
    return null;
  }
  const refs = {
    secrets: new Set<string>(),
    vars: new Set<string>(),
    environments: new Set<string>(),
    hidesUses: false,
  };
  const scan = (expression: string) => {
    if (/toJSON\(\s*secrets\s*\)/.test(expression)) refs.hidesUses = true;
    for (const match of expression.matchAll(CONTEXT_REF)) {
      const name = (match[2] ?? match[3])?.toUpperCase();
      if (!name) continue;
      (match[1] === "secrets" ? refs.secrets : refs.vars).add(name);
    }
  };
  const visit = (value: unknown, key: string | null) => {
    if (typeof value === "string") {
      if (key === "if" && !value.includes("${{")) scan(withoutStrings(value));
      for (const expression of expressions(value)) scan(expression);
      if (key === "secrets" && value.trim() === "inherit") refs.hidesUses = true;
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, null);
    } else if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) visit(v, k);
    }
  };
  visit(data, null);
  const jobs = isRecord(data) && isRecord(data.jobs) ? Object.values(data.jobs) : [];
  for (const job of jobs) {
    const environment = isRecord(job) ? job.environment : undefined;
    const name = isRecord(environment) ? environment.name : environment;
    if (typeof name === "string" && name.trim()) refs.environments.add(name);
  }
  return {
    secrets: [...refs.secrets],
    vars: [...refs.vars],
    environments: [...refs.environments],
    hidesUses: refs.hidesUses,
  };
}

function expressions(text: string): string[] {
  const found: string[] = [];
  for (let start = text.indexOf("${{"); start !== -1; start = text.indexOf("${{", start)) {
    let i = start + 3;
    while (i < text.length && !text.startsWith("}}", i))
      i = text[i] === "'" ? endOfString(text, i) : i + 1;
    found.push(withoutStrings(text.slice(start + 3, i)));
    start = i + 2;
  }
  return found;
}

function withoutStrings(expression: string): string {
  let code = "";
  for (let i = 0; i < expression.length;) {
    if (expression[i] !== "'") {
      code += expression[i];
      i++;
      continue;
    }
    const end = endOfString(expression, i);
    const literal = expression.slice(i, end);
    code += /(?:secrets|vars)\s*\[\s*$/.test(code) ? literal : "''";
    i = end;
  }
  return code;
}

function endOfString(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length) {
    if (text[i] !== "'") i++;
    else if (text[i + 1] === "'") i += 2;
    else return i + 1;
  }
  return i;
}

export interface WorkerDeclaration {
  config: string;
  env: string | null;
  worker: string | null;
  account: string | null;
  required: string[] | null;
  vars: string[];
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

export function wranglerWorkers(
  text: string,
  config: string,
): { ok: true; workers: WorkerDeclaration[] } | { ok: false } {
  let data: unknown;
  try {
    data = config.endsWith(".toml") ? TOML.parse(text) : Bun.JSONC.parse(text);
  } catch {
    return { ok: false };
  }
  if (!isRecord(data)) return { ok: false };
  const topName = stringOf(data.name);
  const topAccount = stringOf(data.account_id);
  const workers = [declaration(config, null, data, topName, topAccount)];
  const envs = isRecord(data.env) ? data.env : {};
  for (const [env, raw] of Object.entries(envs)) {
    if (!isRecord(raw)) continue;
    const name = stringOf(raw.name) ?? (topName ? `${topName}-${env}` : null);
    workers.push(declaration(config, env, raw, name, stringOf(raw.account_id) ?? topAccount));
  }
  return { ok: true, workers };
}

function declaration(
  config: string,
  env: string | null,
  table: Record<string, unknown>,
  worker: string | null,
  account: string | null,
): WorkerDeclaration {
  const secrets = isRecord(table.secrets) ? table.secrets : null;
  const required = Array.isArray(secrets?.required)
    ? secrets.required.filter((n): n is string => typeof n === "string")
    : null;
  return {
    config,
    env,
    worker,
    account: account && ACCOUNT_ID.test(account) ? account : null,
    required,
    vars: isRecord(table.vars) ? Object.keys(table.vars) : [],
  };
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export type StoreRead =
  | { ok: true; secrets: { name: string; updatedAt: string | null }[] }
  | { ok: false; reason: string };

export type Source =
  | { kind: "env-file"; path: string; tracked: boolean | null }
  | { kind: "example-file"; path: string }
  | { kind: "workflow-secret"; path: string }
  | { kind: "workflow-var"; path: string }
  | { kind: "worker-required"; path: string; worker: string | null }
  | { kind: "worker-var"; path: string; worker: string | null }
  | { kind: "github-secret"; repo: string; updatedAt: string | null }
  | { kind: "worker-secret"; worker: string; account: string }
  | { kind: "map"; path: string; keyId: string };

export type Where = "local" | "cloud" | "both" | "declared" | "variable";

export interface NameRow {
  name: string;
  where: Where;
  cloudUnknown: boolean;
  mapped: string[];
  sources: Source[];
  problems: string[];
}

export type DiscoverProblemKind =
  | "tracked-env-file"
  | "missing-github-secret"
  | "unreferenced-github-secret"
  | "missing-worker-secret";

export interface DiscoverProblem {
  kind: DiscoverProblemKind;
  name?: string;
  path?: string;
  message: string;
}

export interface Unknown {
  what: string;
  reason: string;
  cloud: boolean;
}

export interface DiscoverInput {
  envFiles: { path: string; kind: EnvFileKind; names: string[]; tracked: boolean | null }[];
  workflows: { path: string; refs: WorkflowRefs }[];
  workers: (WorkerDeclaration & { read: StoreRead | null })[];
  github: { repo: string; read: StoreRead } | null;
  map: KeysMap | null;
  unknowns: Unknown[];
}

export interface Discovery {
  names: NameRow[];
  problems: DiscoverProblem[];
  unknowns: Unknown[];
}

export const GITHUB_PROVIDED = "GITHUB_TOKEN";

const LOCAL_KINDS: readonly Source["kind"][] = ["env-file"];
const CLOUD_KINDS: readonly Source["kind"][] = ["github-secret", "worker-secret"];
const VARIABLE_KINDS: readonly Source["kind"][] = ["worker-var", "workflow-var"];

export function buildDiscovery(input: DiscoverInput): Discovery {
  const sources = new Map<string, Source[]>();
  const add = (name: string, source: Source) => {
    const list = sources.get(name) ?? [];
    list.push(source);
    sources.set(name, list);
  };
  const problems: DiscoverProblem[] = [];
  const unknowns = [...input.unknowns];

  for (const file of input.envFiles) {
    for (const name of file.names) {
      add(
        name,
        file.kind === "set"
          ? { kind: "env-file", path: file.path, tracked: file.tracked }
          : { kind: "example-file", path: file.path },
      );
    }
    if (file.kind === "set" && file.tracked === true) {
      problems.push({
        kind: "tracked-env-file",
        path: file.path,
        message: `${file.path} is tracked by git, so its values may be committed`,
      });
    }
  }

  const referenced = new Map<string, Set<string>>();
  let hidesUses = false;
  for (const workflow of input.workflows) {
    hidesUses ||= workflow.refs.hidesUses;
    for (const name of workflow.refs.secrets) {
      if (name === GITHUB_PROVIDED) continue;
      const environments = referenced.get(name) ?? new Set<string>();
      for (const environment of workflow.refs.environments) environments.add(environment);
      referenced.set(name, environments);
      add(name, { kind: "workflow-secret", path: workflow.path });
    }
    for (const name of workflow.refs.vars) add(name, { kind: "workflow-var", path: workflow.path });
  }

  const environments = new Set(input.workflows.flatMap((w) => w.refs.environments));
  if (input.github && environments.size) {
    unknowns.push({
      what: `GitHub environment secrets (${[...environments].join(", ")})`,
      reason: "discover reads repo secrets only",
      cloud: true,
    });
  }

  if (input.github) {
    const { repo, read } = input.github;
    if (read.ok) {
      const present = new Set(read.secrets.map((s) => s.name.toUpperCase()));
      for (const secret of read.secrets) {
        add(secret.name, { kind: "github-secret", repo, updatedAt: secret.updatedAt });
        if (!referenced.has(secret.name.toUpperCase())) {
          problems.push({
            kind: "unreferenced-github-secret",
            name: secret.name,
            message: `no workflow here references this ${repo} secret${hidesUses ? " (a workflow passes secrets on, which can hide a use)" : ""}`,
          });
        }
      }
      for (const [name, environments] of referenced) {
        if (present.has(name)) continue;
        const maybe = environments.size
          ? `; it may be a secret of the environment ${[...environments].join(" or ")}, which discover doesn't read`
          : "";
        problems.push({
          kind: "missing-github-secret",
          name,
          message: `a workflow references it, and ${repo} has no repo secret with this name${maybe}`,
        });
      }
    } else {
      unknowns.push({
        what: `GitHub Actions secrets of ${repo}`,
        reason: read.reason,
        cloud: true,
      });
    }
  }

  for (const worker of input.workers) {
    const label = workerLabel(worker);
    for (const name of worker.required ?? []) {
      add(name, { kind: "worker-required", path: worker.config, worker: worker.worker });
    }
    for (const name of worker.vars) {
      add(name, { kind: "worker-var", path: worker.config, worker: worker.worker });
    }
    if (!worker.worker || !worker.account) {
      unknowns.push({
        what: `Worker secrets of ${label}`,
        cloud: true,
        reason: worker.worker
          ? `${worker.config} has no account_id, and discover doesn't guess an account`
          : `${worker.config} names no Worker`,
      });
      continue;
    }
    const read = worker.read;
    if (!read) continue;
    if (!read.ok) {
      unknowns.push({ what: `Worker secrets of ${label}`, reason: read.reason, cloud: true });
      continue;
    }
    const present = new Set(read.secrets.map((s) => s.name));
    for (const secret of read.secrets) {
      add(secret.name, { kind: "worker-secret", worker: worker.worker, account: worker.account });
    }
    for (const name of worker.required ?? []) {
      if (present.has(name)) continue;
      problems.push({
        kind: "missing-worker-secret",
        name,
        message: `${worker.config} requires ${name}, and the Worker ${worker.worker} doesn't have it`,
      });
    }
  }

  for (const key of input.map?.keys ?? []) {
    add(key.env, { kind: "map", path: input.map?.file ?? "keypin.toml", keyId: key.id });
  }

  const cloudUnknown = unknowns.some((u) => u.cloud);
  const names = [...sources.entries()]
    .map(([name, list]): NameRow => {
      const local = list.some((s) => LOCAL_KINDS.includes(s.kind));
      const cloud = list.some((s) => CLOUD_KINDS.includes(s.kind));
      const configured = list.filter((s) => s.kind !== "map");
      const variable =
        configured.length > 0 && configured.every((s) => VARIABLE_KINDS.includes(s.kind));
      return {
        name,
        where:
          local && cloud
            ? "both"
            : local
              ? "local"
              : cloud
                ? "cloud"
                : variable
                  ? "variable"
                  : "declared",
        cloudUnknown: !cloud && cloudUnknown,
        mapped: list.flatMap((s) => (s.kind === "map" ? [s.keyId] : [])),
        sources: list,
        problems: problems
          .filter((p) => p.name?.toUpperCase() === name.toUpperCase())
          .map((p) => p.message),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { names, problems, unknowns };
}

function workerLabel(worker: WorkerDeclaration): string {
  const name = worker.worker ?? "(unnamed)";
  return worker.env
    ? `${name} (${worker.config}, env ${worker.env})`
    : `${name} (${worker.config})`;
}

export interface DraftVault {
  name: string;
  account: string;
  vault: string;
}

export interface DraftOptions {
  project: string;
  githubAccount: string | null;
  vault: DraftVault | null;
  takenIds: readonly string[];
  environments: readonly Environment[];
}

export function draftMap(names: readonly NameRow[], options: DraftOptions): string | null {
  const lines: string[] = [];
  const taken = new Set(options.takenIds);
  const runName = runEnvironment(options);
  const publishName = publishEnvironment(options);
  const vault = options.vault ?? {
    name: "personal",
    account: "<your 1Password account>",
    vault: "<your vault>",
  };
  for (const row of names) {
    if (row.mapped.length) continue;
    const local = row.sources.some((s) => s.kind === "env-file");
    const seen = new Set<string>();
    const publish = row.sources.flatMap((s): string[][] => {
      const place =
        s.kind === "worker-secret"
          ? `${s.account}/${s.worker}`
          : s.kind === "github-secret"
            ? s.repo.toLowerCase()
            : "";
      if (!place || seen.has(place)) return [];
      seen.add(place);
      if (s.kind === "worker-secret")
        return [
          ['to = "cloudflare-worker"', `account = ${str(s.account)}`, `worker = ${str(s.worker)}`],
        ];
      if (s.kind === "github-secret") {
        const account = options.githubAccount;
        const owner = s.repo.split("/")[0]?.toLowerCase();
        return [
          [
            'to = "github-actions"',
            `repo = ${str(s.repo)}`,
            ...(account && account.toLowerCase() !== owner ? [`account = ${str(account)}`] : []),
          ],
        ];
      }
      return [];
    });
    if (!local && !publish.length) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)) continue;

    const id = freeId(keyIdFor(row.name), taken);
    const what = row.name.toLowerCase().replaceAll("_", " ").trim();
    lines.push("", `[keys.${id}]`, `env = ${str(row.name)}`);
    if (local && !(publish.length && runName === publishName)) {
      lines.push(
        "",
        `[keys.${id}.${runName}]`,
        `vault = ${str(vault.name)}`,
        `item = ${str(`${options.project} ${runName} ${what}`)}`,
      );
    }
    if (publish.length) {
      lines.push(
        "",
        `[keys.${id}.${publishName}]`,
        `vault = ${str(vault.name)}`,
        `item = ${str(`${options.project} ${publishName} ${what}`)}`,
      );
      for (const target of publish) {
        lines.push("", `[[keys.${id}.${publishName}.publish]]`, ...target);
      }
    }
  }
  if (!lines.length) return null;
  const header = [
    "# Draft from keypin discover; nothing was written. Vault item names are placeholders.",
    options.vault
      ? "# The vault is the one in this project's keypin.toml; copy only the [keys.*] tables."
      : "# Fill in the vault, then save this as keypin.toml.",
    ...(options.environments.join() === DEFAULT_ENVIRONMENTS.join()
      ? []
      : ["", `environments = [${options.environments.map(str).join(", ")}]`]),
    "",
    `[vaults.${/^[A-Za-z_][A-Za-z0-9_-]*$/.test(vault.name) ? vault.name : str(vault.name)}]`,
    `account = ${str(vault.account)}`,
    `vault = ${str(vault.vault)}`,
  ];
  return `${[...header, ...lines].join("\n")}\n`;
}

function keyIdFor(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll("_", "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-") || "key"
  );
}

function freeId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

function str(value: string): string {
  return JSON.stringify(value);
}
