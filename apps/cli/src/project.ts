import { dirname, join } from "node:path";
import { type Environment, type Files, type KeysMap, parseMap } from "@keypin/core";
import { UsageError } from "./deps";

export const MAP_FILE = "keypin.toml";

export async function findMap(files: Files, cwd: string): Promise<KeysMap> {
  for (let folder = cwd; ; folder = dirname(folder)) {
    const file = join(folder, MAP_FILE);
    const text = await files.read(file);
    if (text !== null) {
      const result = parseMap(text, file);
      if (!result.ok) throw new Error(result.errors.join("\n"));
      return result.map;
    }
    if (dirname(folder) === folder) {
      throw new Error(`no ${MAP_FILE} in ${cwd} or any folder above it; run "keypin init" first`);
    }
  }
}

export function pickEnvironment(
  map: KeysMap,
  requested: string | undefined,
  fallback: Environment,
): Environment {
  if (requested === undefined || map.environments.includes(requested)) return requested ?? fallback;
  const names = map.environments.map((name) => `"${name}"`).join(", ");
  throw new UsageError(`--env is one of ${names} in ${map.file}, got "${requested}"`);
}
