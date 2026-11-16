import { join } from "node:path";
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
