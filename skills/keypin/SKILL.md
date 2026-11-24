---
name: keypin
description: Use the keypin CLI to rotate, publish or check a project's app keys. Use when a key may have leaked or is due, when a project's secretspec.toml has a [tool.keypin] table, or the user asks to rotate, publish or check keys with keypin.
---

# keypin

When a key has to change, keypin replaces it at the provider and at every destination in the project's
`secretspec.toml` (names and vaults, never values); keypin's settings sit under `[tool.keypin]`.
keypin reads values from the vault only while a command needs them. secretspec, not keypin, puts values in the vault
(`secretspec import`, `secretspec set`) and runs the app with them (`secretspec run`).

## Rules

- Never put a value in chat, arguments, files or `secretspec.toml`, and never read an env file's values yourself.
- The user saves values in the vault and answers `y` to approve. You never approve a first write, or a changed
  account or item.
- 1Password asks the user to approve each command, unless the machine uses a service account
  (`KEYPIN_1PASSWORD=service-account`). If a command waits, tell the user. Never set `KEYPIN_1PASSWORD`,
  `OP_SERVICE_ACCOUNT_TOKEN` or another vault's credentials yourself.
- secretspec refuses an agent that gives no reason: add `--reason "<why>"` to each `secretspec` command you run.
- Put keypin's fields only in `[tool.keypin]` tables, never in a key's entry under `[profiles]`.
- Run `keypin --help` first, and use only what it lists.

## Set up

1. No `secretspec.toml`: the user runs `secretspec init`.
2. Run `keypin check --json`. Repeat after each change. It writes nothing and prints no value.
   - `prerequisites`: missing or unverified tools and logins. Tell the user these first; they do them, not you.
   - `problems`: one line per gap, each saying what to run or add. Exit 0 means nothing to fix.
   - `providers`: the `[providers]` and `[defaults]` lines to add when a key has no provider. Ask the user for the
     vault, and for its account only if they want to name one.
   - `unknown`: what check couldn't read. Tell the user it's unverified; it never means missing.
3. Ask the user once, in one message: which names in `local.unmapped` and `local.elsewhere` are secrets; which
   profiles they use besides `default` and `production`; and, for each production secret no env file sets, whether
   it's in the vault. If it's only in GitHub or Cloudflare, they make a new key at the provider and save it with
   `secretspec set`.
4. Give the user the `secretspec add` and `secretspec import` commands from `notes` together, without running them,
   leaving out names that aren't secrets. For a key in an item the user already has, ask for its address and add a
   `ref`.
5. Run `keypin check --json` again. Show the user the `add` TOML and, with their agreement, paste it into
   `secretspec.toml`. Ask for every `<...>` in one list.

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
- To rotate a key with an `issuer`, run `keypin rotate NAME --plan` and show the plan, then give the user the
  printed command to run in a terminal; it asks `y` to rotate and again to revoke the old key. Without an issuer,
  the user makes a new value at the provider, saves it with `secretspec set` (or in the vault, for a `ref` secretspec
  only reads, such as AWS Secrets Manager's) and sets its rotated date to today; then publish it, and remind them to
  revoke the old one.
- When `rotate` says an old key waits, ask the user to confirm nothing still uses it (a published secret isn't proof
  a deployment picked it up), then give them the command it printed, or **approve revoke** with that key filled in.

Details: [How it works](https://github.com/caiopizzol/keypin/blob/main/docs/introduction/how-it-works.md),
[secretspec.toml](https://github.com/caiopizzol/keypin/blob/main/docs/reference/secretspec-toml.md),
[Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/guides/publishing.md),
[Rotating a key](https://github.com/caiopizzol/keypin/blob/main/docs/guides/rotating-a-key.md),
[Troubleshooting](https://github.com/caiopizzol/keypin/blob/main/docs/reference/troubleshooting.md).
