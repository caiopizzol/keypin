import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { register } from "@keypin/core";
import { type Deps, UsageError } from "../deps";
import { projectCount, registryPath } from "../paths";
import { shellWord } from "../publishing";
import { MAP_FILE } from "../project";

export const TEMPLATE = `# keypin.toml: this project's keys. It holds names and places, never values.
# Uncomment and edit. Every field is checked; an unknown one is an error.
#
# The 1Password account the keys below read from: its sign-in address or account ID.
# [1password]
# account = "my.1password.com"
#
# A key, named after the variable your program reads.
# [keys.EXAMPLE_API_KEY]
# rotate_every = "180d" # <n>d, <n>w, <n>m or never
# dev = "op://Private/my-project dev example api key/password" # what keypin run reads
#
# What keypin publish reads, and every place it writes it.
# [keys.EXAMPLE_API_KEY.prod]
# from = "op://Private/my-project prod example api key/password"
#
# [[keys.EXAMPLE_API_KEY.prod.publish]]
# to = "cloudflare-worker"
# account = "<cloudflare account ID>"
# worker = "my-worker"
#
# [[keys.EXAMPLE_API_KEY.prod.publish]]
# to = "github-actions"
# repo = "owner/repo"
`;

export async function init(args: string[], deps: Deps): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length > 1) throw new UsageError("keypin init takes at most one folder");
  const folder = resolve(deps.cwd, positionals[0] ?? ".");
  if (!(await deps.isFolder(folder))) throw new Error(`${folder} isn't a folder`);

  const file = join(folder, MAP_FILE);
  const created = await deps.createFile(file, TEMPLATE);
  if (created === "link")
    throw new Error(`${file} is a symbolic link; keypin init doesn't follow one`);
  deps.stderr.write(
    created === "created"
      ? `keypin: wrote ${file}\n`
      : `keypin: ${file} exists; left it as it is\n`,
  );

  await registerProject(deps, folder);
  deps.stderr.write(
    `keypin: next, run keypin check${folder === deps.cwd ? "" : ` ${shellWord(folder)}`} for what this project uses and the TOML to add\n`,
  );
  return 0;
}

export async function registerProject(deps: Deps, folder: string): Promise<void> {
  const path = registryPath(deps);
  const registry = await register(deps.files, path, folder);
  deps.stderr.write(`keypin: ${folder} is registered (${projectCount(registry, path)})\n`);
}
