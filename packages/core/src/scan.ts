import type { Environment } from "./contracts";
import { Secret } from "./secret";

export type EnvFileKind = "set" | "expected";

export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
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

export function envFileSuffix(fileName: string): string | undefined {
  return ENV_FILE.exec(fileName)?.[2]?.slice(1);
}

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

export type StoreRead =
  | { ok: true; secrets: { name: string; updatedAt: string | null }[] }
  | { ok: false; reason: string };
