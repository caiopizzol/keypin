import { isRecord } from "@keypin/core";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

export const WRANGLER_FILES: readonly string[] = [
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
];

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

function parseConfig(text: string, config: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = config.endsWith(".toml") ? parseToml(text) : jsonc(text);
  } catch {
    return null;
  }
  return isRecord(data) ? data : null;
}

export function calledAcross(configs: readonly { text: string; config: string }[]): Set<string> {
  const names = new Set<string>();
  for (const { text, config } of configs) {
    const data = parseConfig(text, config);
    if (!data) continue;
    const envs = isRecord(data.env) ? Object.values(data.env) : [];
    for (const name of calledWorkers([data, ...envs])) names.add(name);
  }
  return names;
}

export function wranglerWorkers(
  text: string,
  config: string,
  calledElsewhere: ReadonlySet<string> = new Set(),
): { ok: true; workers: WorkerDeclaration[]; skipped: string[] } | { ok: false } {
  const data = parseConfig(text, config);
  if (!data) return { ok: false };
  const topName = stringOf(data.name);
  const topAccount = stringOf(data.account_id);
  const workers = [declaration(config, null, data, topName, topAccount)];
  const skipped: string[] = [];
  const envs = isRecord(data.env) ? data.env : {};
  const called = new Set([...calledWorkers([data, ...Object.values(envs)]), ...calledElsewhere]);
  for (const [env, raw] of Object.entries(envs)) {
    if (!isRecord(raw)) continue;
    const name = stringOf(raw.name) ?? (topName ? `${topName}-${env}` : null);
    if (localOnly(data, raw, name, called)) skipped.push(env);
    else workers.push(declaration(config, env, raw, name, stringOf(raw.account_id) ?? topAccount));
  }
  return { ok: true, workers, skipped };
}

function calledWorkers(tables: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  const add = (list: unknown, field: string) => {
    if (Array.isArray(list))
      for (const item of list) {
        const name = isRecord(item) ? stringOf(item[field]) : null;
        if (name) names.add(name);
      }
  };
  for (const table of tables) {
    if (!isRecord(table)) continue;
    add(table.services, "service");
    add(table.tail_consumers, "service");
    add(table.workflows, "script_name");
    if (isRecord(table.durable_objects)) add(table.durable_objects.bindings, "script_name");
  }
  return names;
}

function hasItems(list: unknown): boolean {
  return Array.isArray(list) && list.length > 0;
}

function exportsObjects(exports: unknown): boolean {
  return (
    isRecord(exports) &&
    Object.values(exports).some((entry) => isRecord(entry) && entry.type === "durable-object")
  );
}

function localOnly(
  top: Record<string, unknown>,
  env: Record<string, unknown>,
  worker: string | null,
  called: ReadonlySet<string>,
): boolean {
  const inherit = (key: string) => env[key] ?? top[key];
  const listed = (table: unknown, key: string) =>
    isRecord(table) && Array.isArray(table[key]) && table[key].length > 0;
  const hosts = (list: unknown) =>
    Array.isArray(list) &&
    list.some((b) => !isRecord(b) || !b.script_name || b.script_name === worker);
  return (
    Array.isArray(env.routes) &&
    env.routes.length === 0 &&
    inherit("workers_dev") === false &&
    inherit("preview_urls") !== true &&
    !listed(inherit("triggers"), "crons") &&
    !listed(env.queues, "consumers") &&
    !hosts(env.workflows) &&
    !(isRecord(env.durable_objects) && hosts(env.durable_objects.bindings)) &&
    !exportsObjects(inherit("exports")) &&
    !hasItems(inherit("migrations")) &&
    !hasItems(top.addresses) &&
    !(worker !== null && called.has(worker))
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
