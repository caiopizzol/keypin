import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, SignInFailed } from "@keypin/core";
import type { Connect } from "./sdk";

const NO_DEFAULT =
  "secretspec.toml's onepassword:// provider names no account, and the 1Password CLI has signed in to none; run op signin once, set OP_ACCOUNT, or write onepassword://<sign-in address>@<vault>";

type Read = (path: string) => string | null;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function defaultAccount(
  env: Readonly<Record<string, string | undefined>> = process.env,
  read: Read = readText,
  home: string = homedir(),
): string | null {
  const set = env.OP_ACCOUNT?.trim();
  if (set) return set;
  const folders = env.OP_CONFIG_DIR
    ? [env.OP_CONFIG_DIR]
    : [join(home, ".config/op"), join(home, ".op")];
  for (const folder of folders) {
    const text = read(join(folder, "config"));
    if (text === null) continue;
    return lastSignIn(text);
  }
  return null;
}

function lastSignIn(text: string): string | null {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(config)) return null;
  const app = config.system_auth_latest_signin;
  if (typeof app === "string" && app.trim()) return app.trim();
  const accounts = Array.isArray(config.accounts) ? config.accounts.filter(isRecord) : [];
  const last = accounts.find((each) => each.shorthand === config.latest_signin);
  const id = last?.accountUUID ?? last?.url;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function withDefaultAccount(
  connect: Connect,
  find: () => string | null = defaultAccount,
): Connect {
  return async (account) => {
    if (account) return connect(account);
    const found = find();
    if (found === null) throw new SignInFailed(NO_DEFAULT, { kind: "unknown-account" });
    return connect(found);
  };
}
