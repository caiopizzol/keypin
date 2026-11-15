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
    const name = isRecord(raw)
      ? (stringOf(raw.name) ?? (topName ? `${topName}-${env}` : null))
      : null;
    if (!isRecord(raw) || localOnly(data, raw, name)) continue;
    workers.push(declaration(config, env, raw, name, stringOf(raw.account_id) ?? topAccount));
  }
  return { ok: true, workers };
}

function localOnly(
  top: Record<string, unknown>,
  env: Record<string, unknown>,
  worker: string | null,
): boolean {
  const inherit = (key: string) => env[key] ?? top[key];
  const listed = (table: unknown, key: string) =>
    isRecord(table) && Array.isArray(table[key]) && table[key].length > 0;
  return (
    Array.isArray(env.routes) &&
    env.routes.length === 0 &&
    inherit("workers_dev") === false &&
    inherit("preview_urls") !== true &&
    !listed(inherit("triggers"), "crons") &&
    !listed(env.queues, "consumers") &&
    !(
      Array.isArray(env.workflows) &&
      env.workflows.some((w) => !isRecord(w) || !w.script_name || w.script_name === worker)
    )
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
