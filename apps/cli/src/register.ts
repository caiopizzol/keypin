import { loadRegistry, register } from "@keypin/core";
import type { Deps } from "./deps";
import { output, tilde } from "./output";
import { registryLocked } from "./publishing";

export async function registerProject(deps: Deps, folder: string): Promise<boolean> {
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  const where = tilde(folder, deps.home);
  try {
    const added = await registryLocked(deps, async (path) => {
      const before = await loadRegistry(deps.files, path);
      if (before.projects.includes(folder)) return false;
      await register(deps.files, path, folder);
      return true;
    });
    if (added) out.line(`${out.mark(true)} keypin status now lists ${where}`);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    out.warn(`keypin status can't list ${where}: ${reason}`);
    return false;
  }
}
