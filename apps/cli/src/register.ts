import { loadRegistry, register } from "@keypin/core";
import type { Deps } from "./deps";
import { output, tilde } from "./output";
import { registryLocked } from "./publishing";

export async function registerProject(deps: Deps, folder: string): Promise<boolean> {
  const added = await registryLocked(deps, async (path) => {
    const before = await loadRegistry(deps.files, path);
    if (before.projects.includes(folder)) return false;
    await register(deps.files, path, folder);
    return true;
  });
  if (added) {
    const out = output(deps.stderr, deps.styled.stderr, deps.columns);
    out.line(`${out.mark(true)} keypin status now lists ${tilde(folder, deps.home)}`);
  }
  return added;
}
