---
name: keypin
description: Use the keypin CLI to map, check, run with, or publish a project's app keys. Use when a project has a keypin.toml, or the user asks to set up, check, run with, publish, or rotate keys with keypin.
---

# keypin

keypin maps a project's keys in `keypin.toml` (variable names and 1Password references, never values) and reads
values from 1Password only while a command runs.

## Rules

- Never put a value in chat, arguments, files or `keypin.toml`, and never read an env file's values yourself.
- The user creates 1Password items and types `yes` to approve. You never approve a first write, or a changed
  account or item.
- 1Password asks the user to approve each command. If a command waits, tell the user.
- Run `keypin --help` first, and use only what it lists.

## Set up

1. No `keypin.toml`: run `keypin init`.
2. Run `keypin check --json`. Repeat after each change. It writes nothing and prints no value.
   - `problems`: one line per gap, each saying what to run or add. Exit 0 means nothing to fix.
   - `unknown`: what check couldn't read. Tell the user it's unverified; it never means missing.
3. Local keys: for each name in `local.unmapped`, ask the user whether it's a secret and which vault. Suggest
   `keypin import <file> NAME... --vault <vault>`, plus `--account <sign-in address>` when `keypin.toml` has no
   `[1password]` account, and `--env <name>` when check's suggestion has it. Run it without `--yes`; it exits 3
   with the command for the user to run. Names in `local.elsewhere` are keys mapped for another environment;
   import adds this environment's entry to each.
4. Production keys: when `add` isn't null, show the user that TOML. With their agreement, paste it into
   `keypin.toml` and ask them for every `<...>` value: the account's sign-in address, each field's secret
   reference (1Password: the field's menu, **Copy Secret Reference**), and any repo, Cloudflare account ID or
   Worker name. keypin rejects a map that still has a `<...>`.

## Run

`keypin run -- <command>` runs a command with the dev keys. If it warns that an env file still holds a key, tell
the user to remove that line. A `.dev.vars` must go entirely, because `wrangler dev` ignores keypin's keys while it
exists. Before the user deletes it, every secret in it must be imported; name each plain setting left in it, so the
user can give it a new home first.

## Publish

1. Run `keypin check --json` and fix every problem until the only ones left say to run `keypin publish`.
2. Run `keypin publish --all --plan` (or `keypin publish NAME --plan`) and show the user the plan. It writes
   nothing; 1Password asks the user to approve the read.
3. Exit 3: give the user the printed command to run in a terminal, where they type `yes`. Exit 0: nothing to
   write. Exit 1: show the problem.
4. Use `--yes` only when the user asks and the plan says it's routine.

"Nothing to write" means this machine's receipts match, not that keypin checked the destination.

## Over time

- `keypin status --json`: every project's keys and when each is due.
- To rotate a key: the user makes a new value at the provider, puts it in the 1Password field and sets `rotated` to
  today; then publish it. Once everything uses the new value, remind the user to revoke the old one.

Details: [Configuration](https://github.com/caiopizzol/keypin/blob/main/docs/configuration.md),
[Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md),
[Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md),
[Notes](https://github.com/caiopizzol/keypin/blob/main/docs/notes.md).
