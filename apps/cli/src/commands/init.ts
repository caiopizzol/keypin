import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { register, shellWord } from "@keypin/core";
import { type Deps, UsageError } from "../deps";
import { count, output, tilde } from "../output";
import { registryLocked } from "../publishing";
import { MAP_FILE } from "../project";

export function template(project: string): string {
  return `# secretspec.toml: this project's secrets, by name and place, never values.
# keypin's settings for each key go in [tool.keypin.<profile>.<KEY>].

[project]
name = ${JSON.stringify(project)}
revision = "1.0"

[profiles.default]

[profiles.production]
`;
}

export async function init(args: string[], deps: Deps): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length > 1) throw new UsageError("keypin init takes at most one folder");
  const folder = resolve(deps.cwd, positionals[0] ?? ".");
  if (!(await deps.isFolder(folder))) throw new Error(`${folder} isn't a folder`);

  const file = join(folder, MAP_FILE);
  const created = await deps.createFile(file, template(basename(folder)));
  if (created === "link")
    throw new Error(`${file} is a symbolic link; keypin init doesn't follow one`);
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  const shown = tilde(file, deps.home);
  out.line(
    created === "created"
      ? `${out.mark(true)} wrote ${shown}`
      : `${out.mark(true)} ${shown} exists; left it as it is`,
  );

  await registerProject(deps, folder);
  out.line(
    `\nNext: keypin check${folder === deps.cwd ? "" : ` ${shellWord(folder)}`}  ${out.dim("what this project uses, and the TOML to add")}`,
  );
  return 0;
}

export async function registerProject(deps: Deps, folder: string): Promise<void> {
  const registry = await registryLocked(deps, (path) => register(deps.files, path, folder));
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  out.line(`${out.mark(true)} registered (${count(registry.projects.length, "project")})`);
}
