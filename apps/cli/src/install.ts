import { fileURLToPath } from "node:url";
import { errorCode, messageOf } from "./errors";

export const INSTALL = "bunx --package vite-plus@1.5.1 vp install";

export function installProblem(
  error: unknown,
  repo = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, ""),
): string | null {
  if (errorCode(error) !== "ERR_MODULE_NOT_FOUND") return null;
  const name = /'([^']+)'/.exec(messageOf(error))?.[1];
  return `${name ? `the package ${name}` : "a package"} isn't installed; run "${INSTALL}" in ${repo}`;
}
