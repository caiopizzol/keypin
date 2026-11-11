---
name: keypin
description: Use the keypin CLI to map, check, run with, publish, or rotate a project's app keys. Use when a project has a keypin.toml, or the user asks to set up, check, run with, publish, or rotate keys with keypin.
---

# keypin

keypin maps each project's keys in `keypin.toml` (names and vault items, never values) and reads values
from 1Password only while a command runs.

- Run `keypin --help` first. It lists the commands and exit codes. Use only what it lists.
- New project: run `keypin discover` and show the draft map. Its vault item names are placeholders;
  ask the user for the real ones. The user creates vault items; you never write a value. `keypin init`
  registers the project but writes only a commented template; fill it from the draft and the answers.
- Check a project: `keypin status --json` for due dates and receipts, and `keypin discover` for the names
  each repo and Worker holds. `cloud unknown` means discover couldn't read it, not that the name is missing.
  `status` exits 1 when it finds a problem; the JSON still prints.
- Run with dev keys: `keypin run -- <command>`.
- 1Password asks the user to approve each command. If a command waits, tell the user to approve it.
- `publish` and `rotate` need a typed `yes` in a terminal, which you don't have. Run them without `--yes`:
  they stop, exit 3, and print the command for the user to run. Use `--yes` only when the user asks and
  the change is a routine update. Nothing else approves a first write, a changed account or item, or a revoke.
- "Nothing to write" means keypin's receipt matches the value, not that it checked the destination.
- `rotate` takes two runs. After the first, the user checks that the new token works; the second revokes
  the old one.
- Never put a value in chat, arguments, files, or `keypin.toml`.

Fields and details:

- [Configuration](https://github.com/caiopizzol/keypin/blob/main/docs/configuration.md)
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md)
- [Rotation](https://github.com/caiopizzol/keypin/blob/main/docs/rotation.md)
- [Notes](https://github.com/caiopizzol/keypin/blob/main/docs/notes.md): `wrangler dev`
