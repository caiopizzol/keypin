---
name: keypin
description: Use the keypin CLI to map, check, run with, publish, or rotate a project's app keys. Use when a project has a keypin.toml, or the user asks to set up, check, run with, publish, or rotate keys with keypin.
---

# keypin

keypin maps each project's keys in `keypin.toml` (variable names and 1Password references, never values) and reads values
from 1Password only while a command runs.

- Run `keypin --help` first. It lists the commands and exit codes. Use only what it lists.
- New project: run `keypin discover --write`. It saves the draft as `keypin.toml` and registers the project,
  but only when there's no map yet, or it's still the `keypin init` template. Show the user the file. Its
  `op://` references are placeholders; ask the user for each field's secret reference (1Password: the field's
  menu, **Copy Secret Reference**) and replace them. The user creates vault items; you never write a value.
  If a real map exists, `--write` exits 1: run `keypin discover` and copy the `[keys.*]` tables by hand.
- Project with a `.env` or `.dev.vars`: suggest `keypin import <file> --vault <vault>` (plus `--account
  <sign-in address>` when there's no map). Ask the user which vault. keypin reads the file locally and creates new
  1Password items; never read, print or pass a value yourself. It needs the user's typed `yes`: run it without
  `--yes`, and it exits 3 with the plan and the command for the user to run. It never changes the file; once it names no
  variable as still only in the file, the user deletes the file.
- A key is named after its variable: `keypin publish API_TOKEN`. If keypin says a map is from keypin 0.4,
  rewrite it in the current format (see Configuration) and show the user the diff.
- Check a project: `keypin status --json` for due dates and receipts, and `keypin discover` for the names
  each repo and Worker holds. `cloud unknown` means discover couldn't read it, not that the name is missing.
  `status` exits 1 when it finds a problem; the JSON still prints. Notices, such as `never-published`, exit 0
  and name the next step.
- Run with dev keys: `keypin run -- <command>`. If it warns that an env file still holds a key, tell the user to
  remove that variable from the file; don't edit the file yourself.
- 1Password asks the user to approve each command. If a command waits, tell the user to approve it.
- `publish` and `rotate` need a typed `yes` in a terminal, which you don't have. Before you hand back the
  command, run it with `--plan` (for a first setup, `keypin publish --all --plan`) and show the user the plan:
  the account checks, what it would write where, and which steps need a typed `yes`. `publish` adds the
  generation it read; `rotate` adds the tokens, and for a revoke, when the old token was last used.
  `--plan` writes nothing and never prints a value. It reads the value, so 1Password asks the user to approve
  it. If an account check or a 1Password read fails, it exits 1 and names the problem. Otherwise it exits 3
  and prints the command without `--plan`; the user runs that in a terminal and types `yes` once for the
  combined plan of every key. Exit 0 means `publish` has nothing to write; `rotate --plan` always exits 3. Use `--yes` only when the user asks and the plan
  says it's routine. Nothing else approves a first write, a changed account or item, or a revoke.
- "Nothing to write" means keypin's receipt matches the value, not that it checked the destination.
- `rotate` takes two runs. After the first, the user checks that the new token works; the second revokes
  the old one. Its `--plan` shows the old token's last-used time; that shows whether something still uses
  it, not that the new one works.
- Never put a value in chat, arguments, files, or `keypin.toml`.

Fields and details:

- [Configuration](https://github.com/caiopizzol/keypin/blob/main/docs/configuration.md)
- [Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md)
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md)
- [Rotation](https://github.com/caiopizzol/keypin/blob/main/docs/rotation.md)
- [Notes](https://github.com/caiopizzol/keypin/blob/main/docs/notes.md): `wrangler dev`
