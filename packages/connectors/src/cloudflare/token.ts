import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withoutSignIn } from "@keypin/core";

export function wranglerConfigFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32")
    throw new Error(
      "keypin doesn't find the wrangler login on Windows yet; publish to Cloudflare from macOS or Linux",
    );
  const legacy = join(home, ".wrangler");
  const base =
    env.XDG_CONFIG_HOME || join(home, platform === "darwin" ? "Library/Preferences" : ".config");
  const folder = isDirectory(legacy) ? legacy : join(base, ".wrangler");
  return join(folder, "config", "default.toml");
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

export async function wranglerToken(path = wranglerConfigFile()): Promise<string> {
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

export async function currentWranglerToken(path = wranglerConfigFile()): Promise<string> {
  const login = await readLogin(path);
  if (login.expired) throw new Error("the wrangler login has expired; run `wrangler whoami`");
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
    execFile("wrangler", ["whoami"], { env: withoutSignIn(process.env) }, (error) => {
      if (error)
        reject(
          new Error("the wrangler login has expired, and `wrangler whoami` couldn't refresh it"),
        );
      else resolve();
    });
  });
}
