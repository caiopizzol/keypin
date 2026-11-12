import { fileURLToPath } from "node:url";
import { errorCode, messageOf } from "./errors";

export const INSTALL = "bunx --package vite-plus@1.5.1 vp install";
export const REINSTALL = "npm install -g keypin";

function checkout(): string | null {
  if (!import.meta.url.endsWith("/apps/cli/src/install.ts")) return null;
  return fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
}

export function installProblem(error: unknown, repo = checkout()): string | null {
  if (errorCode(error) !== "ERR_MODULE_NOT_FOUND") return null;
  const name = /'([^']+)'/.exec(messageOf(error))?.[1];
  const fix =
    repo === null ? `reinstall keypin with "${REINSTALL}"` : `run "${INSTALL}" in ${repo}`;
  return `${name ? `the package ${name}` : "a package"} isn't installed; ${fix}`;
}
