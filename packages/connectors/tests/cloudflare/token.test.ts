import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  API_TOKEN_VARIABLE,
  CloudflareSignInFailed,
  cloudflareSignIn,
  findWrangler,
} from "../../src/cloudflare/index";

const TOKEN = "oauth-sentinel-5c1d";
const AMBIENT = "ambient-cf-token-9e0a";
const OAUTH = JSON.stringify({ type: "oauth", token: TOKEN });
const SIGN_IN = ["OP_SERVICE_ACCOUNT_TOKEN"];

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "keypin-cf-")));
  made.push(dir);
  return dir;
}

interface FakeWrangler {
  stdout?: string;
  stderr?: string;
  exit?: number;
  version?: string;
  sleep?: number;
}

async function fakeWrangler(dir: string, fake: FakeWrangler): Promise<string> {
  await mkdir(dir, { recursive: true });
  const seen = join(dir, "seen");
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${fake.version ?? "4.153.0"}"; exit 0; fi
{ echo "args=$*"; echo "cwd=$(pwd)"; env | sort; } > "${seen}"
${fake.sleep ? `sleep ${fake.sleep}` : ""}
printf '%s' '${fake.stdout ?? OAUTH}'
printf '%s' '${fake.stderr ?? ""}' >&2
exit ${fake.exit ?? 0}
`;
  const path = join(dir, "wrangler");
  await writeFile(path, script);
  await chmod(path, 0o755);
  return seen;
}

async function project(fake: FakeWrangler = {}) {
  const root = await folder();
  const seen = await fakeWrangler(join(root, "node_modules", ".bin"), fake);
  return { root, seen };
}

async function config(root: string, at: string) {
  await mkdir(join(root, at), { recursive: true });
  await writeFile(join(root, at, "wrangler.jsonc"), "{}");
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error,
  );

describe("cloudflareSignIn through wrangler auth token", () => {
  test("returns the OAuth token wrangler gives, however the login is stored", async () => {
    const { root, seen } = await project();
    const signIn = cloudflareSignIn({
      signIn: SIGN_IN,
      env: { PATH: "/usr/bin:/bin" },
      folder: root,
    });
    expect(signIn.via).toBe("oauth");
    expect(await signIn.token()).toBe(TOKEN);
    const ran = await readFile(seen, "utf8");
    expect(ran).toContain(`args=auth token --json --env-file /dev/null\n`);
    expect(ran).not.toContain(`cwd=${root}\n`);
  });

  test("a broken wrangler.toml in the project doesn't block the login", async () => {
    const root = await folder();
    const bin = join(root, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(root, "wrangler.toml"), 'name = "billing"\ncompatibility_date = 123\n');
    const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "4.153.0"; exit 0; fi
if [ -f wrangler.toml ]; then echo "Processing wrangler.toml configuration: invalid compatibility_date" >&2; exit 1; fi
printf '%s' '${OAUTH}'
`;
    await writeFile(join(bin, "wrangler"), script);
    await chmod(join(bin, "wrangler"), 0o755);
    expect(
      await cloudflareSignIn({
        signIn: SIGN_IN,
        env: { PATH: "/usr/bin:/bin" },
        folder: root,
      }).token(),
    ).toBe(TOKEN);
  });

  test("asks wrangler once per sign-in", async () => {
    const { root, seen } = await project();
    const signIn = cloudflareSignIn({
      signIn: SIGN_IN,
      env: { PATH: "/usr/bin:/bin" },
      folder: root,
    });
    await signIn.token();
    await rm(seen);
    expect(await signIn.token()).toBe(TOKEN);
    await expect(readFile(seen, "utf8")).rejects.toThrow();
  });

  test("an expired login works: wrangler refreshes it and keypin reads no file", async () => {
    const { root } = await project({ stdout: JSON.stringify({ type: "oauth", token: "fresh" }) });
    const home = await folder();
    await mkdir(join(home, ".wrangler/config"), { recursive: true });
    await writeFile(
      join(home, ".wrangler/config/default.toml"),
      `oauth_token = "stale"\nexpiration_time = "2000-01-01T00:00:00Z"\n`,
    );
    const signIn = cloudflareSignIn({
      signIn: SIGN_IN,
      env: { PATH: "/usr/bin:/bin", HOME: home },
      folder: root,
    });
    expect(await signIn.token()).toBe("fresh");
  });

  test("wrangler never sees the ambient Cloudflare credentials or keypin's sign-in", async () => {
    const { root, seen } = await project();
    const env = {
      PATH: "/usr/bin:/bin",
      CLOUDFLARE_API_TOKEN: AMBIENT,
      CLOUDFLARE_API_KEY: AMBIENT,
      CLOUDFLARE_EMAIL: "me@example.com",
      CF_API_TOKEN: AMBIENT,
      CF_API_KEY: AMBIENT,
      CF_EMAIL: "me@example.com",
      OP_SERVICE_ACCOUNT_TOKEN: AMBIENT,
      WRANGLER_LOG: "debug",
      KEEP_ME: "yes",
    };
    expect(await cloudflareSignIn({ signIn: SIGN_IN, env, folder: root }).token()).toBe(TOKEN);
    const ran = await readFile(seen, "utf8");
    expect(ran).not.toContain(AMBIENT);
    expect(ran).not.toMatch(/^(CLOUDFLARE_EMAIL|CF_EMAIL)=/m);
    expect(ran).toContain("KEEP_ME=yes\n");
    expect(ran).toContain("WRANGLER_LOG=log\n");
    expect(ran).toContain("WRANGLER_WRITE_LOGS=false\n");
  });

  test("finds a workspace's wrangler in a monorepo when the root has none", async () => {
    const root = await folder();
    await config(root, "apps/api");
    const seen = await fakeWrangler(join(root, "apps", "api", "node_modules", ".bin"), {});
    expect(await findWrangler(root, "")).toBe(join(root, "apps/api/node_modules/.bin/wrangler"));
    expect(
      await cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "" }, folder: root }).token(),
    ).toBe(TOKEN);
    expect(await readFile(seen, "utf8")).toContain("args=auth token --json");
  });

  test("finds the wrangler a package above a nested wrangler config installs", async () => {
    const root = await folder();
    await config(root, "labs/apps/site");
    await fakeWrangler(join(root, "labs", "node_modules", ".bin"), {});
    expect(await findWrangler(root, "")).toBe(join(root, "labs/node_modules/.bin/wrangler"));
    await fakeWrangler(join(root, "labs", "apps", "site", "node_modules", ".bin"), {});
    expect(await findWrangler(root, "")).toBe(
      join(root, "labs/apps/site/node_modules/.bin/wrangler"),
    );
  });

  test("in a monorepo, skips a workspace's wrangler too old for auth token and uses the next", async () => {
    const root = await folder();
    await config(root, "apps/admin");
    await config(root, "apps/api");
    await fakeWrangler(join(root, "apps", "admin", "node_modules", ".bin"), {
      version: "4.20.0",
      exit: 1,
      stdout: "",
      stderr: "Unknown argument: token",
    });
    const seen = await fakeWrangler(join(root, "apps", "api", "node_modules", ".bin"), {});
    expect(
      await cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "" }, folder: root }).token(),
    ).toBe(TOKEN);
    expect(await readFile(seen, "utf8")).toContain("args=auth token --json");
  });

  test("looks only next to wrangler configs outside dot folders and node_modules", async () => {
    const root = await folder();
    await fakeWrangler(join(root, "apps", "api", "node_modules", ".bin"), {});
    await config(root, "apps/.cache");
    await fakeWrangler(join(root, "apps", ".cache", "node_modules", ".bin"), {});
    await config(root, "node_modules/pkg");
    await fakeWrangler(join(root, "node_modules", "pkg", "node_modules", ".bin"), {});
    expect(await findWrangler(root, "")).toBeNull();
  });

  test("uses the project's wrangler before the one on PATH, from a subfolder too", async () => {
    const { root, seen } = await project();
    const onPath = await folder();
    const pathSeen = await fakeWrangler(onPath, {
      stdout: JSON.stringify({ type: "oauth", token: "path" }),
    });
    const sub = join(root, "apps", "web");
    await mkdir(sub, { recursive: true });
    expect(await findWrangler(sub, onPath)).toBe(join(root, "node_modules/.bin/wrangler"));
    expect(
      await cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: onPath }, folder: sub }).token(),
    ).toBe(TOKEN);
    expect(await readFile(seen, "utf8")).toContain("args=auth token --json");
    await expect(readFile(pathSeen, "utf8")).rejects.toThrow();

    const bare = await folder();
    expect(
      await cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: onPath }, folder: bare }).token(),
    ).toBe("path");
  });

  test("a wrangler found through a relative PATH entry still runs from the temporary folder", async () => {
    const tools = await folder();
    const seen = await fakeWrangler(join(tools, "bin"), {});
    const before = process.cwd();
    process.chdir(tools);
    try {
      const bare = await folder();
      expect(await findWrangler(bare, "bin")).toBe(join(tools, "bin", "wrangler"));
      expect(
        await cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "bin" }, folder: bare }).token(),
      ).toBe(TOKEN);
      expect(await readFile(seen, "utf8")).toContain("args=auth token --json");
    } finally {
      process.chdir(before);
    }
  });

  test("without wrangler, says to install it", async () => {
    const bare = await folder();
    const error = await failure(
      cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: await folder() }, folder: bare }).token(),
    );
    expect(error).toBeInstanceOf(CloudflareSignInFailed);
    expect(error).toMatchObject({
      kind: "no-wrangler",
      install: "in the project (npm i -D wrangler)",
    });
    expect(String(error)).toContain(
      "install it in the project (npm i -D wrangler) and run wrangler login",
    );
  });

  test.each([
    ["pnpm-lock.yaml", "pnpm add -D wrangler"],
    ["yarn.lock", "yarn add -D wrangler"],
    ["bun.lock", "bun add -d wrangler"],
    ["bun.lockb", "bun add -d wrangler"],
  ])("with %s, says to install wrangler with %s", async (lockfile, command) => {
    const root = await folder();
    await writeFile(join(root, lockfile), "");
    const error = await failure(
      cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "" }, folder: root }).token(),
    );
    expect(error).toMatchObject({ kind: "no-wrangler", install: `in the project (${command})` });
  });

  test("says to install wrangler in the package that holds the wrangler configs", async () => {
    const root = await folder();
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    await writeFile(join(root, "package.json"), "{}");
    await config(root, "labs/apps/site");
    await config(root, "labs/apps/api");
    await writeFile(join(root, "labs", "package.json"), "{}");
    const error = await failure(
      cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "" }, folder: root }).token(),
    );
    expect(error).toMatchObject({ install: "in labs (pnpm add -D wrangler)" });
    await writeFile(join(root, "labs", "pnpm-workspace.yaml"), "packages: [apps/*]\n");
    const again = await failure(
      cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "" }, folder: root }).token(),
    );
    expect(again).toMatchObject({ install: "in labs (pnpm add -D -w wrangler)" });
  });

  test("a wrangler without auth token says which version to upgrade to", async () => {
    const { root } = await project({
      version: "4.42.0",
      exit: 1,
      stdout: "",
      stderr: `Unknown arguments: json, ${TOKEN}`,
    });
    const error = await failure(
      cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "/usr/bin:/bin" }, folder: root }).token(),
    );
    expect(error).toMatchObject({ kind: "old-wrangler" });
    expect(String(error)).toContain(
      "wrangler 4.42.0 can't give keypin its login; upgrade wrangler to 4.57.0 or later",
    );
    expect(String(error)).not.toContain(TOKEN);
  });

  test("a wrangler that isn't signed in says to run wrangler login", async () => {
    const { root } = await project({
      exit: 1,
      stdout: "",
      stderr: "✘ [ERROR] Not logged in. Please run `wrangler login` to authenticate.",
    });
    const error = await failure(
      cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "/usr/bin:/bin" }, folder: root }).token(),
    );
    expect(error).toMatchObject({ kind: "not-logged-in" });
    expect(String(error)).toContain("wrangler isn't signed in; run wrangler login");
  });

  test("any other failure prints none of wrangler's output", async () => {
    const { root } = await project({
      exit: 1,
      stdout: TOKEN,
      stderr: `refresh failed for ${TOKEN}`,
    });
    const error = await failure(
      cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "/usr/bin:/bin" }, folder: root }).token(),
    );
    expect(error).toMatchObject({ kind: "failed" });
    expect(error).toBeInstanceOf(Error);
    expect(`${String(error)} ${error instanceof Error ? error.stack : ""}`).not.toContain(TOKEN);
  });

  test.each([
    [
      "an API key sign-in",
      JSON.stringify({ type: "api_key", key: TOKEN, email: "me@example.com" }),
      "api_key",
    ],
    ["an empty token", JSON.stringify({ type: "oauth", token: " " }), "empty"],
    ["malformed JSON", `{"type":"oauth","token":"${TOKEN}"`, "can't read"],
    [
      "an API token wrangler found itself",
      JSON.stringify({ type: "api_token", token: TOKEN }),
      "api_token",
    ],
  ])("refuses %s, without printing it", async (_name, stdout, says) => {
    const { root } = await project({ stdout });
    const error = await failure(
      cloudflareSignIn({ signIn: SIGN_IN, env: { PATH: "/usr/bin:/bin" }, folder: root }).token(),
    );
    expect(error).toBeInstanceOf(CloudflareSignInFailed);
    expect(String(error)).toContain(says);
    expect(String(error)).not.toContain(TOKEN);
  });

  test("a wrangler that hangs is stopped", async () => {
    const { root } = await project({ sleep: 5 });
    const started = Date.now();
    const error = await failure(
      cloudflareSignIn({
        signIn: SIGN_IN,
        env: { PATH: "/usr/bin:/bin" },
        folder: root,
        timeoutMs: 300,
      }).token(),
    );
    expect(String(error)).toContain("didn't answer in time");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("on Windows, says to use an API token", async () => {
    const { root } = await project();
    const signIn = cloudflareSignIn({
      signIn: SIGN_IN,
      env: { PATH: "/usr/bin:/bin" },
      folder: root,
      platform: "win32",
    });
    expect(String(await failure(signIn.token()))).toContain(`set ${API_TOKEN_VARIABLE}`);
  });
});

describe(`cloudflareSignIn with ${API_TOKEN_VARIABLE}`, () => {
  test("uses the variable without running wrangler, even on Windows", async () => {
    const { root, seen } = await project();
    for (const platform of ["darwin", "win32"]) {
      const signIn = cloudflareSignIn({
        signIn: SIGN_IN,
        env: {
          PATH: "/usr/bin:/bin",
          [API_TOKEN_VARIABLE]: ` ${TOKEN}\n`,
          CLOUDFLARE_API_TOKEN: AMBIENT,
        },
        folder: root,
        platform,
      });
      expect(signIn.via).toBe("api-token");
      expect(await signIn.token()).toBe(TOKEN);
    }
    await expect(readFile(seen, "utf8")).rejects.toThrow();
  });

  test("an empty variable fails instead of falling back to wrangler", async () => {
    const { root, seen } = await project();
    const signIn = cloudflareSignIn({
      signIn: SIGN_IN,
      env: { PATH: "/usr/bin:/bin", [API_TOKEN_VARIABLE]: "" },
      folder: root,
    });
    expect(signIn.via).toBe("api-token");
    expect(String(await failure(signIn.token()))).toContain(
      `${API_TOKEN_VARIABLE} is set but empty`,
    );
    await expect(readFile(seen, "utf8")).rejects.toThrow();
  });

  test("CLOUDFLARE_API_TOKEN alone is never used to sign in", async () => {
    const { root } = await project();
    const signIn = cloudflareSignIn({
      signIn: SIGN_IN,
      env: { PATH: "/usr/bin:/bin", CLOUDFLARE_API_TOKEN: AMBIENT },
      folder: root,
    });
    expect(signIn.via).toBe("oauth");
    expect(await signIn.token()).toBe(TOKEN);
  });
});
