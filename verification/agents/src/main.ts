#!/usr/bin/env -S bun --no-env-file
import { driver } from "./driver";

process.exitCode = await driver(process.argv.slice(2), {
  cwd: process.cwd(),
  script: process.argv[1] ?? "",
  stdout: process.stdout,
  stderr: process.stderr,
});
