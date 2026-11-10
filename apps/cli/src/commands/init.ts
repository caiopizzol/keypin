import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { register } from "@keypin/core";
import { type Deps, UsageError } from "../deps";
import { projectCount, registryPath } from "../paths";
import { MAP_FILE } from "../project";

export const TEMPLATE = `# keypin.toml: this project's keys. It holds names and places, never values.
# Uncomment and edit. Every field is checked; an unknown one is an error.
#
# A vault the keys below read from. The name ("personal") is yours to choose.
# [vaults.personal]
# kind = "1password"
# account = "my.1password.com"
# vault = "Private"
#
# A key. Its ID ("example-api-key") stays the same when vault items are renamed.
# [keys.example-api-key]
# env = "EXAMPLE_API_KEY" # the variable your program reads
# owner = "my-project"
# rotate_every = "180d" # <n>d, <n>w, <n>m or never; leave out to use the vault item's rotate_every
#
# Where keypin run reads the value from.
# [keys.example-api-key.dev]
# vault = "personal"
# item = "my-project dev example api key"
#
# Where keypin publish reads it from, and every place it writes it.
# [keys.example-api-key.prod]
# vault = "personal"
# item = "my-project prod example api key"
#
# [[keys.example-api-key.prod.publish]]
# to = "cloudflare-worker"
# account = "<cloudflare account ID>"
# worker = "my-worker"
#
# [[keys.example-api-key.prod.publish]]
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

  const path = registryPath(deps);
  const registry = await register(deps.files, path, folder);
  deps.stderr.write(`keypin: ${folder} is registered (${projectCount(registry, path)})\n`);
  return 0;
}
