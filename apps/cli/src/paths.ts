import { join } from "node:path";
import type { Registry } from "@keypin/core";
import type { Deps } from "./deps";

export function registryPath(deps: Pick<Deps, "env" | "home">): string {
  return join(base(deps.env.XDG_CONFIG_HOME, deps.home, ".config"), "keypin", "registry.json");
}

export function statePath(deps: Pick<Deps, "env" | "home">): string {
  return join(base(deps.env.XDG_STATE_HOME, deps.home, ".local/state"), "keypin", "state.json");
}

function base(xdg: string | undefined, home: string, fallback: string): string {
  return xdg?.startsWith("/") ? xdg : join(home, fallback);
}

export function projectCount(registry: Registry, path: string): string {
  const count = registry.projects.length;
  return `${count} ${count === 1 ? "project" : "projects"} in ${path}`;
}
