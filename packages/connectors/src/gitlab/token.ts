import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { withoutSignIn } from "@keypin/core";

export const TOKEN_VARIABLE = "KEYPIN_GITLAB_TOKEN";
const GLAB_TOKENS = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];

export const tokensPage = (host: string) =>
  `https://${host}/-/user_settings/personal_access_tokens`;

export type SignInVia = "token" | "glab";

export class GitLabSignInFailed extends Error {}

export interface GitLabSignIn {
  readonly via: SignInVia;
  token(): Promise<string>;
}

export type Glab = (args: string[], env: Record<string, string>) => Promise<GlabRun>;
export type GlabRun = { ok: boolean; stdout: string; missing: boolean };

export interface SignInOptions {
  env: Readonly<Record<string, string | undefined>>;
  signIn: readonly string[];
  host: string;
  glab?: Glab;
}

export function gitlabSignIn(options: SignInOptions): GitLabSignIn {
  const value = options.env[TOKEN_VARIABLE];
  if (value !== undefined)
    return {
      via: "token",
      token: async () => {
        const token = value.trim();
        if (token) return token;
        throw new GitLabSignInFailed(
          `${TOKEN_VARIABLE} is set but empty; set it to a GitLab access token with the api scope, or unset it to use the glab login`,
        );
      },
    };
  return { via: "glab", token: () => glabToken(options) };
}

async function glabToken({ env, signIn, host, glab = runGlab }: SignInOptions): Promise<string> {
  const kept = withoutSignIn(env, [...signIn, TOKEN_VARIABLE, ...GLAB_TOKENS]);
  const asked = await glab(["config", "get", "token", "--host", host], kept);
  const token = asked.ok ? asked.stdout.trim() : "";
  if (token) return token;
  throw new GitLabSignInFailed(signInProblem(env, host, asked.missing ? "missing" : "signed out"));
}

export function signInProblem(
  env: Readonly<Record<string, string | undefined>>,
  host: string,
  glab: "missing" | "signed out",
): string {
  const ambient = GLAB_TOKENS.filter((name) => env[name]);
  const note = ambient.length
    ? `; ${ambient.join(" and ")} ${ambient.length > 1 ? "are" : "is"} set, but keypin doesn't sign in with ${ambient.length > 1 ? "them" : "it"}, so ${ambient.length > 1 ? "they stay keys" : "it stays a key"} your map can hold`
    : "";
  const login = glab === "missing" ? "keypin can't find glab" : `glab has no token for ${host}`;
  return `${login}, and ${TOKEN_VARIABLE} isn't set${note}. Run glab auth login --hostname ${host}, or create a personal, project or group access token with the api scope (${tokensPage(host)}) and set ${TOKEN_VARIABLE}`;
}

export function findGlab(path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "glab");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

const runGlab: Glab = (args, env) => {
  const found = findGlab(env.PATH ?? "");
  if (!found) return Promise.resolve({ ok: false, stdout: "", missing: true });
  return new Promise((resolve) => {
    execFile(found, args, { env, timeout: 30_000 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout), missing: false });
    });
  });
};
