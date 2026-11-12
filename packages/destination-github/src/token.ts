import { execFile } from "node:child_process";

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

function noToken(login: string | null): Error {
  return new Error(
    `gh has no token for ${login ?? "an active login"}; run: gh auth login --hostname github.com`,
  );
}

function runGh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return new Promise((resolve) => {
    execFile("gh", args, { env }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
