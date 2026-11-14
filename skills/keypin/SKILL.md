---
name: keypin
description: Use the keypin CLI to map, check, run with, or publish a project's app keys. Use when a project has a keypin.toml, or the user asks to set up, check, run with, publish, or rotate keys with keypin.
---

# keypin

keypin maps a project's keys in `keypin.toml` (variable names and 1Password references, never values) and reads
values from 1Password only while a command runs.

## Rules

- Never put a value in chat, arguments, files or `keypin.toml`, and never read an env file's values yourself.
- The user creates 1Password items and answers `y` to approve. You never approve a first write, or a changed
  account or item.
- 1Password asks the user to approve each command, unless the machine uses a service account
  (`KEYPIN_1PASSWORD=service-account`). If a command waits, tell the user. Never set `KEYPIN_1PASSWORD` or
  `OP_SERVICE_ACCOUNT_TOKEN` yourself.
- Run `keypin --help` first, and use only what it lists.

## Set up

1. No `keypin.toml`: run `keypin init`.
2. Run `keypin check --json`. Repeat after each change. It writes nothing and prints no value.
   - `prerequisites`: missing or unverified tools and logins. Tell the user these first; they do them, not you.
   - `problems`: one line per gap, each saying what to run or add. Exit 0 means nothing to fix.
   - `unknown`: what check couldn't read. Tell the user it's unverified; it never means missing.
3. Ask the user once, in one message: which names in `local.unmapped` and `local.elsewhere` are secrets; the vault,
   and the sign-in address if `keypin.toml` has no account; whether they use staging; and, for each prod or staging
   secret no env file sets, whether it's in 1Password. If it's only in GitHub or Cloudflare, they make a new key at
   the provider and put it in 1Password.
4. Import first: keypin won't import into a map with a `<...>`. For each env file, run check's suggested
   `keypin import`, with `--env <name>` for another environment's file (`.env.staging` gets `--env staging`, once
   `environments` lists it; use the line check prints). Run each without `--yes`; it exits 3 with a command for the
   user. Give the user all of these commands together; each also asks for a 1Password approval. If import can't
   add a table to a key, ask the user for that reference and add it by hand.
5. Run `keypin check --json` again. Show the user the `add` TOML and, with their agreement, paste it into
   `keypin.toml`. Ask for every `<...>` in one list (a reference: the 1Password field's menu, **Copy Secret
   Reference**).

## Run

`keypin run -- <command>` runs a command with the dev keys. With `--env prod`, add `--only NAME` for each key the
command needs: a CI token such as `CLOUDFLARE_API_TOKEN` replaces the tool's own login. If it warns that an env file
still holds a key, tell the user to remove that line. A `.dev.vars` must go entirely, because `wrangler dev` ignores
keypin's keys while it exists. Before the user deletes it, every secret in it must be imported; name each plain
setting left in it, so the user can give it a new home first: `wrangler dev --var NAME:value`, not `[vars]`, which
also deploys.

## Publish

1. Run `keypin check --json` and fix every problem you can. Problems that say to run `keypin publish`, or that
   wait on a command you handed to the user, don't block the plan.
2. Run `keypin publish --all --plan` (or `keypin publish NAME --plan`) and show the user the plan. It writes
   nothing; 1Password asks the user to approve the read.
3. Exit 3: give the user the printed command to run in a terminal, where they answer `y`. Exit 0: nothing to
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
