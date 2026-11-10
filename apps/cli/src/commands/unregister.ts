import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRegistry, unregister as remove } from "@keypin/core";
import { type Deps, UsageError } from "../deps";
import { projectCount, registryPath } from "../paths";

export async function unregister(args: string[], deps: Deps): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length > 1) throw new UsageError("keypin unregister takes at most one folder");
  const folder = resolve(deps.cwd, positionals[0] ?? ".");
  const path = registryPath(deps);
  const before = await loadRegistry(deps.files, path);
  const registry = await remove(deps.files, path, folder);
  if (before.projects.length === registry.projects.length) {
    const listed = registry.projects.map((project) => `\n  ${project}`).join("");
    deps.stderr.write(
      `keypin: ${folder} wasn't registered (${projectCount(registry, path)})${listed}\n`,
    );
    return 1;
  }
  deps.stderr.write(
    `keypin: ${folder} is no longer registered (${projectCount(registry, path)})\n`,
  );
  return 0;
}
