import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const WRANGLER_CONFIG = join(homedir(), "Library/Preferences/.wrangler/config/default.toml");

export async function wranglerToken(path = WRANGLER_CONFIG): Promise<string> {
  let login = await readLogin(path);
  if (login.expired) {
    await refresh();
    login = await readLogin(path);
    if (login.expired)
      throw new Error(
        "the wrangler login is still expired after `wrangler whoami`; run `wrangler login`",
      );
  }
  return login.token;
}

async function readLogin(path: string): Promise<{ token: string; expired: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`no wrangler login at ${path}; run \`wrangler login\``);
  }
  const token = tomlString(text, "oauth_token");
  if (!token) throw new Error(`${path} has no oauth_token; run \`wrangler login\``);
  const expires = Date.parse(tomlString(text, "expiration_time") ?? "");
  return { token, expired: Number.isNaN(expires) || expires <= Date.now() + 60_000 };
}

function tomlString(text: string, key: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (match?.[1] === key) return match[2] ?? null;
  }
  return null;
}

function refresh(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("wrangler", ["whoami"], (error) => {
      if (error)
        reject(
          new Error("the wrangler login has expired, and `wrangler whoami` couldn't refresh it"),
        );
      else resolve();
    });
  });
}
