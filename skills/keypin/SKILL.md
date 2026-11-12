---
name: keypin
description: Use the keypin CLI to map, check, run with, or publish a project's app keys. Use when a project has a keypin.toml, or the user asks to set up, check, run with, publish, or rotate keys with keypin.
---

# keypin

keypin maps each project's keys in `keypin.toml` (variable names and 1Password references, never values) and reads values
from 1Password only while a command runs.

- Run `keypin --help` first. It lists the commands and exit codes. Use only what it lists.
- Start with `keypin check --json` in the project's folder, before anything else and again after each change. It
  works with no map and on the `keypin init` template, writes nothing, and prints no value. `problems` lists one
  line per gap, each naming what to run or add; `unknown` lists reads it couldn't make (unknown never means
  missing). No `keypin.toml` yet: run `keypin init` first.
- Production gap: when `add` isn't null, show the user that TOML. It adds a `[keys.X.prod]` table and its
  `[[keys.X.prod.publish]]` destination for each secret a workflow or Worker needs that the map doesn't publish
  there. Paste it into `keypin.toml` only when the user agrees, and ask the user for every `<...>` value: the
  1Password account's sign-in address, and each field's secret reference (1Password: the field's menu, **Copy
  Secret Reference**). keypin rejects a map that still has a `<...>`. The user creates vault items; you never
  write a value.
- Local gap: `local` lists, per env file, the names the map doesn't have, and `problems` names the
  `keypin import` command. Suggest `keypin import <file> [NAME...] --vault <vault>` (plus `--account <sign-in
  address>` when there's no map). Ask the user which vault, and which variables are keys; plain settings such as `PORT` can stay in the
  file. keypin reads the file locally and creates new 1Password items; never read, print or pass a value yourself.
  It needs the user's typed `yes`: run it without `--yes`, and it exits 3 with the plan and the command for the
  user to run. It never changes the file; the user removes the lines it names, or deletes the file when it says
  nothing else is set in it. A `.dev.vars` must go entirely: while it exists, `wrangler dev` ignores the keys
  `keypin run` provides. Suggest importing every secret in it. For a plain setting left in it, tell the user by
  name that it needs a new home before they delete the file; don't read or move its value yourself.
- A key is named after its variable: `keypin publish API_TOKEN`. If keypin says a map is from keypin 0.4,
  rewrite it in the current format (see Configuration) and show the user the diff.
- Before you publish, or say a setup is done, run `keypin check --json` and get it to exit 0. It also checks that
  the map parses, that each item exists, and that each login reaches the pinned account, with a `fix` for each
  mismatch. It finds items in the vault's item list without reading a value, so it doesn't check the field
  inside; 1Password still asks the user to approve the command.
- Over time: `keypin status --json` lists every registered project's due dates and receipts, and names a project
  with no keys. For one project's gaps, use `keypin check`. `status` exits 1 when it finds a problem; the JSON
  still prints. Notices, such as `never-published`, exit 0 and name the next step.
- Run with dev keys: `keypin run -- <command>`. If it warns that an env file still holds a key, tell the user to
  remove that variable from the file; don't edit the file yourself.
- 1Password asks the user to approve each command. If a command waits, tell the user to approve it.
- `publish` needs a typed `yes` in a terminal, which you don't have. Before you hand back the
  command, run it with `--plan` (for a first setup, `keypin publish --all --plan`) and show the user the plan:
  the account checks, the generation it read, what it would write where, and which steps need a typed `yes`.
  `--plan` writes nothing and never prints a value. It reads the value, so 1Password asks the user to approve
  it. If an account check or a 1Password read fails, it exits 1 and names the problem. Otherwise it exits 3
  and prints the command without `--plan`; the user runs that in a terminal and types `yes` once for the
  combined plan of every key. Exit 0 means `publish` has nothing to write. Use `--yes` only when the user asks and the plan
  says it's routine. Nothing else approves a first write, or a changed account or item.
- "Nothing to write" means the receipts on this machine match the value, not that keypin checked the
  destination.
- keypin has no rotate command. To rotate a key that `status` shows as due, the user makes a new value at
  the provider, puts it in the 1Password field and sets the item's `rotated` date to today; then publish it
  as above. If a map has a `rotate` section, keypin rejects it: delete the section and show the user the diff.
- Never put a value in chat, arguments, files, or `keypin.toml`.

Fields and details:

- [Configuration](https://github.com/caiopizzol/keypin/blob/main/docs/configuration.md)
- [Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md)
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md)
- [Notes](https://github.com/caiopizzol/keypin/blob/main/docs/notes.md): `wrangler dev`
