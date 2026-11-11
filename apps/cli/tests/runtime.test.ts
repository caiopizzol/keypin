import { describe, expect, test } from "vite-plus/test";
import { MIN_BUN, NO_ENV_FILE, runtimeProblem } from "../src/runtime";

const FLAGS = [NO_ENV_FILE];

describe("runtimeProblem", () => {
  test("Node is refused before any Bun API is touched", () => {
    expect(runtimeProblem(undefined, "/bin/keypin", FLAGS)).toBe(
      `keypin runs on Bun ${MIN_BUN} or newer, not Node.`,
    );
  });

  test("an older Bun names the script that was run", () => {
    expect(runtimeProblem("1.3.12", "/usr/local/bin/keypin", FLAGS)).toContain(
      `run it with "bunx bun@${MIN_BUN} ${NO_ENV_FILE} /usr/local/bin/keypin"`,
    );
  });

  test("the minimum and anything newer pass", () => {
    expect(runtimeProblem(MIN_BUN, "keypin", FLAGS)).toBeNull();
    expect(runtimeProblem("1.10.0", "keypin", FLAGS)).toBeNull();
  });

  test("Bun that loaded .env files is refused, with the command that doesn't", () => {
    expect(runtimeProblem(MIN_BUN, "/repo/apps/cli/src/main.ts", [])).toBe(
      `keypin needs Bun started with ${NO_ENV_FILE}, or Bun adds this folder's .env values to every command keypin runs. Run it as "keypin", or as "bun ${NO_ENV_FILE} /repo/apps/cli/src/main.ts".`,
    );
  });

  test("an explicit --env-file is refused, even with --no-env-file and from BUN_OPTIONS", () => {
    for (const flags of [
      [NO_ENV_FILE, "--env-file=.env"],
      ["--env-file", ".env", NO_ENV_FILE],
    ]) {
      expect(runtimeProblem(MIN_BUN, "keypin", flags)).toBe(
        "keypin can't run with Bun's --env-file: Bun would add that file's values to every command keypin runs. Remove --env-file from the command and from BUN_OPTIONS.",
      );
    }
  });
});
