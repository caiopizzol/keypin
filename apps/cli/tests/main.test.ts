import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { NO_ENV_FILE } from "../src/runtime";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const MAP = `[vaults.personal]
kind = "1password"
account = "my.1password.com"
vault = "Private"
`;

let folder = "";
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "keypin-main-"));
  await writeFile(join(folder, ".env"), "FROM_DOTENV=leaked\n");
  await writeFile(join(folder, "keypin.toml"), MAP);
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function keypin(bunFlags: string[], args: string[], extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "FROM_DOTENV") env[name] = value;
  }
  const child = Bun.spawn([process.execPath, ...bunFlags, MAIN, ...args], {
    cwd: folder,
    env: {
      ...env,
      ...extra,
      XDG_CONFIG_HOME: join(folder, "config"),
      XDG_STATE_HOME: join(folder, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("main", () => {
  test("the shebang starts Bun without loading .env files", async () => {
    const text = await Bun.file(MAIN).text();
    expect(text.split("\n")[0]).toBe(`#!/usr/bin/env -S bun ${NO_ENV_FILE}`);
  });

  test("keypin run doesn't pass a value from the folder's .env", async () => {
    const run = await keypin(
      [NO_ENV_FILE],
      ["run", "--", "sh", "-c", 'echo "${FROM_DOTENV:-unset}"'],
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("unset\n");
  });

  test("Bun started without the flag is refused before anything runs", async () => {
    const run = await keypin([], ["run", "--", "sh", "-c", 'echo "${FROM_DOTENV:-unset}"']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`keypin needs Bun started with ${NO_ENV_FILE}`);
  });

  test("an --env-file in BUN_OPTIONS is refused before anything runs", async () => {
    const run = await keypin(
      [NO_ENV_FILE],
      ["run", "--", "sh", "-c", 'echo "${FROM_DOTENV:-unset}"'],
      {
        BUN_OPTIONS: "--env-file=.env",
      },
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("keypin can't run with Bun's --env-file");
  });
});
