import { execFile } from "node:child_process";
import { withoutSignIn } from "@keypin/core";

const NO_REFRESH = "--no-refresh";

export async function ghToken(
  login: string | null,
  options: { refresh?: boolean } = {},
): Promise<string> {
  const args = ["auth", "token", "--hostname", "github.com", ...(login ? ["--user", login] : [])];
  if (options.refresh !== false) return askGh(args, login);
  const asked = await runGh([...args, NO_REFRESH]);
  if (asked.ok) return tokenFrom(asked.stdout, login);
  if (asked.stderr.includes(`unknown flag: ${NO_REFRESH}`)) return askGh(args, login);
  throw noToken(login);
}

async function askGh(args: string[], login: string | null): Promise<string> {
  const asked = await runGh(args);
  if (!asked.ok) throw noToken(login);
  return tokenFrom(asked.stdout, login);
}

function tokenFrom(stdout: string, login: string | null): string {
  const token = stdout.trim();
  if (!token) throw noToken(login);
  return token;
}

const SIGN_IN = "gh auth login --hostname github.com";
const ENV_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN"];

export function envTokens(env: Readonly<Record<string, string | undefined>>): string[] {
  return ENV_TOKENS.filter((name) => env[name]);
}

export function tokenOnly(names: readonly string[]): { why: string; command: string } {
  const unset = names.join(" and ");
  return {
    why: `keypin ignores ${unset}: it publishes only as a login gh has saved, so a token meant for another tool can't pick the account`,
    command: `unset ${names.join(" ")}, then run ${SIGN_IN} --with-token < token.txt with a classic token that has the repo, read:org and gist scopes (gh needs all three)`,
  };
}

function noToken(login: string | null): Error {
  const names = envTokens(process.env);
  return new Error(
    `gh has no token for ${login ?? "an active login"}; ${names.length ? Object.values(tokenOnly(names)).join("; ") : `run: ${SIGN_IN}`}`,
  );
}

function runGh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const env = withoutSignIn(process.env);
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return new Promise((resolve) => {
    execFile("gh", args, { env }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
