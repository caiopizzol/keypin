import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { ghToken } from "../src/index";

const USER_TOKEN = "sentinel-user-token-5d1e";
const ENV_TOKEN = "sentinel-env-token-9a7c";
const ACTIVE_TOKEN = "sentinel-active-token-3e8f";
const SAVED = { ...process.env };

const FAKE_GH = `#!/bin/sh
if [ -n "$FAKE_GH_LOG" ]; then echo "$*" >> "$FAKE_GH_LOG"; fi
args="$*"
case "$args" in
  *" --no-refresh")
    if [ -n "$FAKE_GH_OLD" ]; then echo "unknown flag: --no-refresh" >&2; echo "Usage:  gh auth token [flags]" >&2; exit 1; fi
    args="\${args% --no-refresh}" ;;
esac
if [ "$args" = "auth token --hostname github.com" ]; then echo "${ACTIVE_TOKEN}"; exit 0; fi
if [ "$args" != "auth token --hostname github.com --user someone" ]; then echo "unexpected args: $*" >&2; exit 3; fi
if [ -n "$FAKE_GH_EMPTY" ]; then exit 0; fi
if [ -n "$GH_TOKEN" ] || [ -n "$GITHUB_TOKEN" ]; then echo "${ENV_TOKEN}"; else echo "${USER_TOKEN}"; fi
echo "fake gh failing on purpose" >&2
exit "\${FAKE_GH_EXIT:-0}"
`;

let bin: string;

beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "keypin-fake-gh-"));
  await writeFile(join(bin, "gh"), FAKE_GH);
  await chmod(join(bin, "gh"), 0o755);
});

afterAll(async () => {
  await rm(bin, { recursive: true, force: true });
});

afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in SAVED)) delete process.env[name];
  Object.assign(process.env, SAVED);
});

async function asked(run: () => Promise<unknown>): Promise<string[]> {
  process.env.FAKE_GH_LOG = join(bin, `log-${Math.random()}`);
  await run().catch(() => null);
  return (await readFile(process.env.FAKE_GH_LOG, "utf8")).trim().split("\n");
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("ghToken", () => {
  test("asks gh for the login's token, with GH_TOKEN and GITHUB_TOKEN kept from gh", async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.GH_TOKEN = ENV_TOKEN;
    process.env.GITHUB_TOKEN = ENV_TOKEN;
    expect(await ghToken("someone")).toBe(USER_TOKEN);
    expect(process.env.GH_TOKEN).toBe(ENV_TOKEN);
    expect(process.env.GITHUB_TOKEN).toBe(ENV_TOKEN);
  });

  test("with no login chosen, asks gh for the active login's token", async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(await ghToken(null)).toBe(ACTIVE_TOKEN);
  });

  test("a failing gh that printed a token leaves the token out of the error", async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.FAKE_GH_EXIT = "1";
    process.env.GH_TOKEN = ENV_TOKEN;
    const error = await failure(ghToken("someone"));
    expect(error).toBeInstanceOf(Error);
    const everything = [
      error instanceof Error ? error.message : "",
      error instanceof Error ? error.stack : "",
      JSON.stringify(error),
      inspect(error, { depth: 5, showHidden: true }),
      String(error),
    ].join("\n");
    expect(everything).toContain("gh has no token for someone; run: gh auth login");
    expect(everything).not.toContain(USER_TOKEN);
    expect(everything).not.toContain(ENV_TOKEN);
    expect(everything).not.toContain("fake gh failing on purpose");
  });

  test("an empty answer from gh is no token", async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.FAKE_GH_EMPTY = "1";
    expect(await failure(ghToken("someone"))).toEqual(
      new Error("gh has no token for someone; run: gh auth login --hostname github.com"),
    );
  });

  test("no gh on PATH is the same clear error", async () => {
    process.env.PATH = "/nonexistent";
    expect(await failure(ghToken("someone"))).toEqual(
      new Error("gh has no token for someone; run: gh auth login --hostname github.com"),
    );
  });

  test("refreshing is the default, so publish and rotate ask gh without --no-refresh", async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(await asked(() => ghToken("someone"))).toEqual([
      "auth token --hostname github.com --user someone",
    ]);
  });

  test("without refresh, asks gh with --no-refresh", async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(await ghToken("someone", { refresh: false })).toBe(USER_TOKEN);
    expect(await asked(() => ghToken("someone", { refresh: false }))).toEqual([
      "auth token --hostname github.com --user someone --no-refresh",
    ]);
    expect(await asked(() => ghToken(null, { refresh: false }))).toEqual([
      "auth token --hostname github.com --no-refresh",
    ]);
  });

  test("a gh older than 2.103.0, which has no --no-refresh and never refreshes, is asked again without it", async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.FAKE_GH_OLD = "1";
    expect(await ghToken("someone", { refresh: false })).toBe(USER_TOKEN);
    expect(await asked(() => ghToken("someone", { refresh: false }))).toEqual([
      "auth token --hostname github.com --user someone --no-refresh",
      "auth token --hostname github.com --user someone",
    ]);
  });

  test("without refresh, any other failure is no token, with no second ask", async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.FAKE_GH_EXIT = "1";
    expect(await failure(ghToken("someone", { refresh: false }))).toEqual(
      new Error("gh has no token for someone; run: gh auth login --hostname github.com"),
    );
    expect(await asked(() => ghToken("someone", { refresh: false }))).toEqual([
      "auth token --hostname github.com --user someone --no-refresh",
    ]);
  });
});
