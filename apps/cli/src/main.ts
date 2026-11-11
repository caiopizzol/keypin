#!/usr/bin/env -S bun --no-env-file
import { installProblem } from "./install";
import { runtimeProblem } from "./runtime";

const problem = runtimeProblem(
  typeof Bun === "undefined" ? undefined : Bun.version,
  process.argv[1] ?? "keypin",
  process.execArgv,
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
