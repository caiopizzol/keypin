import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { Environment } from "./contracts";
import { isRecord } from "./record";
import { Secret } from "./secret";

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
  return [...envValues(text).keys()];
}

export function envValues(text: string): Map<string, Secret> {
  const values = new Map<string, Secret>();
  for (const match of text.replace(/\r\n?/g, "\n").matchAll(DOTENV_LINE)) {
    if (match[1]) values.set(match[1], new Secret(dotenvValue(match[2] ?? "")));
  }
  return values;
}

function dotenvValue(raw: string): string {
  const value = raw.trim();
  const unquoted = value.replace(/^(['"`])([\s\S]*)\1$/, "$2");
  return value.startsWith('"') ? unquoted.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : unquoted;
}

export function draftItemName(project: string, environment: Environment, name: string): string {
  const folder = project.replace(/[^A-Za-z0-9 ._-]/g, "-");
  return `${folder} ${environment} ${name.toLowerCase().replaceAll("_", " ").trim()}`;
}

export interface WorkflowRefs {
  secrets: string[];
  vars: string[];
  environments: string[];
  uses: { environment: string | null; secrets: string[] }[];
  hidesUses: boolean;
}

const CONTEXT_REF =
  /(?<![\w.])(secrets|vars)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\])/g;

export function workflowRefs(text: string): WorkflowRefs | null {
  let data: unknown;
  try {
    data = parseYaml(text, { logLevel: "error" });
  } catch {
    return null;
  }
  const refs = {
    secrets: new Set<string>(),
    vars: new Set<string>(),
    environments: new Set<string>(),
    hidesUses: false,
  };
  const secretsIn = (root: unknown, skip: unknown): Set<string> => {
    const secrets = new Set<string>();
    const scan = (expression: string) => {
      if (/toJSON\(\s*secrets\s*\)/.test(expression)) refs.hidesUses = true;
      for (const match of expression.matchAll(CONTEXT_REF)) {
        const name = (match[2] ?? match[3])?.toUpperCase();
        if (!name) continue;
        (match[1] === "secrets" ? secrets : refs.vars).add(name);
      }
    };
    const seen = new Set<unknown>([skip]);
    const visit = (value: unknown, key: string | null) => {
      if (typeof value === "string") {
        if (key === "if" && !value.includes("${{")) scan(withoutStrings(value));
        for (const expression of expressions(value)) scan(expression);
        if (key === "secrets" && value.trim() === "inherit") refs.hidesUses = true;
        return;
      }
      if (typeof value !== "object" || value === null || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) visit(item, null);
      } else if (isRecord(value)) {
        for (const [k, v] of Object.entries(value)) visit(v, k);
      }
    };
    visit(root, null);
    for (const name of secrets) refs.secrets.add(name);
    return secrets;
  };
  const jobs = isRecord(data) && isRecord(data.jobs) ? data.jobs : null;
  const uses: WorkflowRefs["uses"] = [{ environment: null, secrets: [...secretsIn(data, jobs)] }];
  for (const job of Object.values(jobs ?? {})) {
    const environment = isRecord(job) ? job.environment : undefined;
    const name = isRecord(environment) ? environment.name : environment;
    const named = typeof name === "string" && name.trim() ? name : null;
    if (named !== null) refs.environments.add(named);
    uses.push({ environment: named?.trim() ?? null, secrets: [...secretsIn(job, null)] });
  }
  return {
    secrets: [...refs.secrets],
    vars: [...refs.vars],
    environments: [...refs.environments],
    uses: uses.filter((use) => use.secrets.length),
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

function jsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const data: unknown = parseJsonc(text.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: true,
  });
  return errors.length ? undefined : data;
}

export function wranglerWorkers(
  text: string,
  config: string,
): { ok: true; workers: WorkerDeclaration[] } | { ok: false } {
  let data: unknown;
  try {
    data = config.endsWith(".toml") ? parseToml(text) : jsonc(text);
  } catch {
    return { ok: false };
  }
  if (!isRecord(data)) return { ok: false };
  const topName = stringOf(data.name);
  const topAccount = stringOf(data.account_id);
  const workers = [declaration(config, null, data, topName, topAccount)];
  const envs = isRecord(data.env) ? data.env : {};
  for (const [env, raw] of Object.entries(envs)) {
    if (!isRecord(raw) || localOnly(data, raw)) continue;
    const name = stringOf(raw.name) ?? (topName ? `${topName}-${env}` : null);
    workers.push(declaration(config, env, raw, name, stringOf(raw.account_id) ?? topAccount));
  }
  return { ok: true, workers };
}

function localOnly(top: Record<string, unknown>, env: Record<string, unknown>): boolean {
  const inherit = (key: string) => env[key] ?? top[key];
  const listed = (table: unknown, key: string) =>
    isRecord(table) && Array.isArray(table[key]) && table[key].length > 0;
  return (
    Array.isArray(env.routes) &&
    env.routes.length === 0 &&
    inherit("workers_dev") === false &&
    !listed(inherit("triggers"), "crons") &&
    !listed(env.queues, "consumers")
  );
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
