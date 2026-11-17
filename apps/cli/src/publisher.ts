import { type PublishTarget, signInVariables } from "@keypin/core";
import type { Deps, Publisher } from "./deps";

export async function publisherFor(
  targets: readonly PublishTarget[],
  deps: Deps,
  folder = deps.cwd,
  refreshLogins = true,
): Promise<{ publisher: Publisher; notes: string[] }> {
  let publisher: Publisher = {
    githubLogin: null,
    workerSignIn: null,
    signInEnv: deps.env,
    refreshLogins,
    signInVariables: signInVariables([...deps.vaults, ...deps.destinations]),
  };
  const notes: string[] = [];
  for (const kind of deps.destinations) {
    if (!kind.publisher || !targets.some((target) => target.to === kind.kind)) continue;
    const part = await kind.publisher(deps, folder);
    publisher = { ...publisher, ...part.fields, refreshLogins };
    notes.push(...(part.notes ?? []));
  }
  return { publisher, notes };
}
