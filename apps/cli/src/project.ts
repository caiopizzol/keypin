import { dirname, join } from "node:path";
import {
  type Environment,
  type KeysMap,
  type MapResult,
  readSecretspec,
  SECRETSPEC_FILE,
} from "@keypin/core";
import { type Deps, UsageError } from "./deps";

export const MAP_FILE = SECRETSPEC_FILE;
export const STATUS_FILE = ".keypin/status.json";
export const ROTATION_FILE = ".keypin/rotation.json";

export async function findMap(deps: Deps): Promise<KeysMap> {
  const found = await locateMap(deps.files, deps.cwd);
  if (!found) {
    throw new Error(
      `no ${MAP_FILE} in ${deps.cwd} or any folder above it; create one with secretspec init`,
    );
  }
  const result = readMap(deps, found);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.map;
}

export function readMap(
  deps: Pick<Deps, "destinations" | "issuers" | "vaults" | "pulls">,
  found: { file: string; text: string },
): MapResult {
  return readSecretspec(
    found.text,
    found.file,
    deps.destinations,
    deps.issuers,
    deps.vaults,
    deps.pulls,
  );
}

export async function locateMap(
  files: Deps["files"],
  cwd: string,
): Promise<{ file: string; text: string } | null> {
  for (let folder = cwd; ; folder = dirname(folder)) {
    const file = join(folder, MAP_FILE);
    const text = await files.read(file);
    if (text !== null) return { file, text };
    if (dirname(folder) === folder) return null;
  }
}

export function pickEnvironment(
  map: KeysMap,
  requested: string | undefined,
  fallback: Environment,
): Environment {
  if (requested === undefined || map.environments.includes(requested)) return requested ?? fallback;
  const names = map.environments.map((name) => `"${name}"`).join(", ");
  throw new UsageError(`--profile is one of ${names} in ${map.file}, got "${requested}"`);
}
