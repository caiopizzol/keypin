#!/usr/bin/env -S bun --no-env-file
import { installProblem } from "./install";
import { type Compiled, runtimeProblem } from "./runtime";

declare const KEYPIN_COMPILED: string | undefined;

const compiled: Compiled | undefined =
  typeof Bun !== "undefined" && Bun.isStandaloneExecutable
    ? {
        autoload: typeof KEYPIN_COMPILED === "string" ? KEYPIN_COMPILED : undefined,
        env: process.env,
      }
    : undefined;
const problem = runtimeProblem(
  typeof Bun === "undefined" ? undefined : Bun.version,
  process.argv[1] ?? "keypin",
  process.execArgv,
  compiled,
);
if (problem) {
  process.stderr.write(`keypin: ${problem}\n`);
  process.exit(1);
}

let start: typeof import("./start");
try {
  start = await import("./start");
} catch (error) {
  const hint = installProblem(error);
  if (!hint) throw error;
  process.stderr.write(`keypin: ${hint}\n`);
  process.exit(1);
}
process.exitCode = await start.main();
