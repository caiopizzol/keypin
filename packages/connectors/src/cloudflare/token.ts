import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { isRecord, withoutSignIn } from "@keypin/core";

export const API_TOKEN_VARIABLE = "KEYPIN_CLOUDFLARE_API_TOKEN";
export const FIRST_AUTH_TOKEN = "4.57.0";

const WRANGLER_CREDENTIALS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
];

export type SignInVia = "api-token" | "oauth";

export type SignInProblem = "no-wrangler" | "old-wrangler" | "not-logged-in" | "failed";

export class CloudflareSignInFailed extends Error {
  readonly kind: SignInProblem;

  constructor(message: string, kind: SignInProblem) {
    super(message);
    this.kind = kind;
  }
}

export interface CloudflareSignIn {
  readonly via: SignInVia;
  token(): Promise<string>;
}

export interface SignInOptions {
  env: Readonly<Record<string, string | undefined>>;
  signIn: readonly string[];
  folder: string;
  platform?: string;
  timeoutMs?: number;
}

export function cloudflareSignIn(options: SignInOptions): CloudflareSignIn {
  const variable = options.env[API_TOKEN_VARIABLE];
  const via: SignInVia = variable === undefined ? "oauth" : "api-token";
  let token: Promise<string> | undefined;
  return {
    via,
    token: () => (token ??= variable === undefined ? oauthToken(options) : apiToken(variable)),
  };
}

async function apiToken(value: string): Promise<string> {
  const token = value.trim();
  if (!token)
    throw new CloudflareSignInFailed(
      `${API_TOKEN_VARIABLE} is set but empty; set it to a Cloudflare API token, or unset it to use the wrangler login`,
      "failed",
    );
  return token;
}

async function oauthToken(options: SignInOptions): Promise<string> {
  if ((options.platform ?? process.platform) === "win32")
    throw new CloudflareSignInFailed(
      `keypin can't run wrangler on Windows yet; set ${API_TOKEN_VARIABLE} to a Cloudflare API token`,
      "failed",
    );
  const found = wranglers(options.folder, options.env.PATH ?? "");
  if (!found.length)
    throw new CloudflareSignInFailed(
      `keypin can't find wrangler in the project's node_modules or on PATH; install it and run wrangler login, or set ${API_TOKEN_VARIABLE}`,
      "no-wrangler",
    );
  const logs = await mkdtemp(join(tmpdir(), "keypin-wrangler-"));
  try {
    let tooOld: CloudflareSignInFailed | null = null;
    for (const wrangler of found) {
      const run = (args: string[], timeout: number) =>
        runWrangler(wrangler, args, {
          cwd: logs,
          env: wranglerEnv(options.env, options.signIn, logs),
          timeout,
        });
      const asked = await run(
        ["auth", "token", "--json", "--env-file", devNull],
        options.timeoutMs ?? 30_000,
      );
      if (asked.timedOut)
        throw new CloudflareSignInFailed(
          "wrangler auth token didn't answer in time; run it to see why",
          "failed",
        );
      if (asked.ok) return tokenFrom(asked.stdout);
      const why = await whyNot(asked.stderr, () => run(["--version"], 15_000));
      if (why.kind !== "old-wrangler") throw why;
      tooOld ??= why;
    }
    throw tooOld ?? new CloudflareSignInFailed("wrangler couldn't give keypin its login", "failed");
  } finally {
    await rm(logs, { recursive: true, force: true });
  }
}

function wranglerEnv(
  env: Readonly<Record<string, string | undefined>>,
  signIn: readonly string[],
  logs: string,
): Record<string, string> {
  const kept = withoutSignIn(env, [...signIn, API_TOKEN_VARIABLE, ...WRANGLER_CREDENTIALS]);
  return {
    ...kept,
    WRANGLER_LOG: "log",
    WRANGLER_LOG_PATH: logs,
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
  };
}

export function findWrangler(folder: string, path: string): string | null {
  return wranglers(folder, path)[0] ?? null;
}

export function wranglers(folder: string, path: string): string[] {
  const found: string[] = [];
  for (let dir = folder; ; dir = dirname(dir)) {
    found.push(join(dir, "node_modules", ".bin", "wrangler"));
    if (dirname(dir) === dir) break;
  }
  for (const dir of path.split(delimiter)) if (dir) found.push(resolve(join(dir, "wrangler")));
  for (const group of readable(folder))
    if (group !== "node_modules" && !group.startsWith("."))
      for (const member of readable(join(folder, group)))
        if (!member.startsWith("."))
          found.push(join(folder, group, member, "node_modules", ".bin", "wrangler"));
  return [...new Set(found)].filter(executable);
}

function readable(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whyNot(
  stderr: string,
  version: () => Promise<Ran>,
): Promise<CloudflareSignInFailed> {
  const ran = await version();
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(ran.ok ? ran.stdout : "")?.[0];
  if (found && older(found, FIRST_AUTH_TOKEN))
    return new CloudflareSignInFailed(
      `wrangler ${found} can't give keypin its login; upgrade wrangler to ${FIRST_AUTH_TOKEN} or later`,
      "old-wrangler",
    );
  if (/not logged in/i.test(stderr))
    return new CloudflareSignInFailed(
      `wrangler isn't signed in; run wrangler login, or set ${API_TOKEN_VARIABLE}`,
      "not-logged-in",
    );
  return new CloudflareSignInFailed(
    "wrangler couldn't give keypin its login; run wrangler auth token to see why, or wrangler login to sign in again",
    "failed",
  );
}

function older(version: string, than: string): boolean {
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

function tokenFrom(stdout: string): string {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = null;
  }
  if (!isRecord(data))
    throw new CloudflareSignInFailed(
      "wrangler auth token --json printed something keypin can't read; upgrade wrangler",
      "failed",
    );
  if (data.type !== "oauth")
    throw new CloudflareSignInFailed(
      `wrangler gave a ${typeof data.type === "string" ? data.type : "unknown"} sign-in, not its OAuth login; run wrangler login`,
      "failed",
    );
  const token = typeof data.token === "string" ? data.token.trim() : "";
  if (!token)
    throw new CloudflareSignInFailed(
      "wrangler gave an empty login token; run wrangler login",
      "failed",
    );
  return token;
}

interface Ran {
  ok: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function runWrangler(
  wrangler: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeout: number },
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      wrangler,
      args,
      { ...options, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          timedOut: Boolean(error && "killed" in error && error.killed),
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    child.stdin?.end();
  });
}
