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
   - `prerequisites`: missing or unverified tools and logins. Tell the user these first; they do them, not you.
   - `problems`: one line per gap, each saying what to run or add. Exit 0 means nothing to fix.
   - `unknown`: what check couldn't read. Tell the user it's unverified; it never means missing.
3. Ask the user once, in one message, not name by name:
   - which names in `local.unmapped` and `local.elsewhere` are secrets (plain settings such as `PORT` stay);
   - the vault, and the 1Password sign-in address when `keypin.toml` has no `[1password]` account;
   - whether they use staging. If so, make sure `environments` lists it before importing: add
     `environments = ["dev", "staging", "prod"]` at the top, or add `"staging"` before the last name in the line
     that's there;
   - for each prod or staging secret that no env file sets: is it already in 1Password, or only in GitHub or
     Cloudflare? keypin can't read a value back from those, so it has to be made again at the provider and put in
     1Password by the user.
4. Import before you paste any TOML, because keypin won't import into a map with a `<...>`. For each env file, run
   check's suggested `keypin import <file> NAME... --vault <vault>`, with `--account` when check's suggestion has
   it. Add `--env <name>` for every file that holds another environment's values: `.env.staging` gets
   `--env staging`, and `.env.production` gets `--env prod` when the map calls it `prod`. Without it, import maps
   the values as the first environment; check's note says when that would happen. Run each without `--yes`; it exits 3 with a
   command for the user. Give the user all of these commands together, and say that each one also asks for a
   1Password approval. If import can't add a table to a key, ask the user for that reference and add it by hand.
5. Run `keypin check --json` again. When `add` isn't null, show the user that TOML and, with their agreement, paste
   it at the end of `keypin.toml`. Ask for every `<...>` left, in one list: each secret reference (1Password: the
   field's menu, **Copy Secret Reference**), and any repo, Cloudflare account ID or Worker name. keypin rejects a
   map that still has a `<...>`.

## Run

`keypin run -- <command>` runs a command with the dev keys. If it warns that an env file still holds a key, tell
the user to remove that line. A `.dev.vars` must go entirely, because `wrangler dev` ignores keypin's keys while it
exists. Before the user deletes it, every secret in it must be imported; name each plain setting left in it, so the
user can give it a new home first: `wrangler dev --var NAME:value`, not `[vars]`, which also deploys.

## Publish

1. Run `keypin check --json` and fix every problem you can. Problems that say to run `keypin publish`, or that
   wait on a command you handed to the user, don't block the plan.
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
