import { describe, expect, test } from "vite-plus/test";
import {
  COMPILED_AUTOLOAD_OFF,
  COMPILED_REFUSED_ENV,
  MIN_BUN,
  NO_ENV_FILE,
  runtimeProblem,
  selfCommand,
} from "../src/runtime";

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

  test("the command keypin prints to rerun itself keeps --no-env-file and no other Bun flag", () => {
    expect(selfCommand("/opt/bun", "/usr/local/bin/keypin")).toEqual([
      "/opt/bun",
      NO_ENV_FILE,
      "/usr/local/bin/keypin",
    ]);
  });

  test("a compiled binary built with autoload off passes without --no-env-file", () => {
    expect(
      runtimeProblem(MIN_BUN, "keypin", [], { autoload: COMPILED_AUTOLOAD_OFF, env: {} }),
    ).toBeNull();
  });

  test("a compiled binary without the build-time marker is refused", () => {
    expect(runtimeProblem(MIN_BUN, "keypin", [NO_ENV_FILE], { autoload: undefined, env: {} })).toBe(
      "this keypin binary wasn't built by apps/cli/compile.ts, so it may load this folder's .env and bunfig.toml. Build it with that script.",
    );
  });

  test("a compiled binary refuses each variable that loads code or a debugger, even when empty", () => {
    for (const name of COMPILED_REFUSED_ENV) {
      expect(
        runtimeProblem(MIN_BUN, "keypin", [], {
          autoload: COMPILED_AUTOLOAD_OFF,
          env: { [name]: "" },
        }),
      ).toBe(
        `keypin can't run with ${name} set: Bun would let it load code or a debugger into keypin. Unset ${name}.`,
      );
    }
    expect(
      runtimeProblem(MIN_BUN, "keypin", [], {
        autoload: COMPILED_AUTOLOAD_OFF,
        env: { BUN_OPTIONS: "--preload ./x.js", BUN_INSPECT: "127.0.0.1:0" },
      }),
    ).toBe(
      "keypin can't run with BUN_OPTIONS and BUN_INSPECT set: Bun would let them load code or a debugger into keypin. Unset BUN_OPTIONS and BUN_INSPECT.",
    );
  });

  test("a compiled binary still needs the minimum Bun", () => {
    expect(
      runtimeProblem("1.3.12", "keypin", [], { autoload: COMPILED_AUTOLOAD_OFF, env: {} }),
    ).toContain("keypin needs Bun 1.4.4 or newer");
  });
});
