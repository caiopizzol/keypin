---
name: keypin
description: Use the keypin CLI to rotate, publish or check a project's app keys. Use when a key may have leaked or is due, when a project's secretspec.toml has a [tool.keypin] table, or the user asks to rotate, publish or check keys with keypin.
---

# keypin

keypin replaces a key at its provider and at every destination in the project's `secretspec.toml`, which holds
names and vaults, never values. secretspec puts values in the vault (`secretspec import`, `secretspec set`) and runs
the app with them (`secretspec run`).

## Rules

- Never put a value in chat, arguments, files or `secretspec.toml`, and never read an env file's values.
- The user saves values in the vault and answers `y` to approve. Never approve a first write, or a changed account
  or item.
- When a command waits for 1Password, tell the user to approve it. Never set `KEYPIN_1PASSWORD`,
  `OP_SERVICE_ACCOUNT_TOKEN` or another vault's credentials.
- Add `--reason "<why>"` to every `secretspec` command you run.
- Put keypin's fields only in `[tool.keypin]` tables.
- Run `keypin --help` first, and use only what it lists.

## Set up

1. No `secretspec.toml`: the user runs `secretspec init`.
2. Run `keypin check --json`, and again after each change. It writes nothing and prints no value.
   - `prerequisites`: tools and logins the user sets up, not you.
   - `problems`: each says what to run or add. Exit 0 means nothing to fix.
   - `unknown`: unverified, never missing.
3. Ask the user in one message: which names in `local` are secrets, which vault to use, which profiles they use
   besides `default` and `production`, and whether each production secret is in the vault. A secret only in GitHub
   or Cloudflare can't be read back: the user makes a new key and saves it with `secretspec set`.
4. Give the user the `secretspec add` and `secretspec import` commands from `notes` to run, leaving out names that
   aren't secrets.
5. With the user's agreement, paste the `providers` and `add` TOML into `secretspec.toml`. Ask for every `<...>` in
   one list.

## Publish

1. Run `keypin publish --all --plan` (or `keypin publish NAME --plan`) and show the plan. It writes nothing.
2. Exit 3: give the user the printed command to run in a terminal. Exit 0: nothing to write. Exit 1: show the
   problem.
3. Use `--yes` only when the user asks and the plan says it's routine.

## Rotate

- With an `issuer`: run `keypin rotate NAME --plan`, show the plan, and give the user the printed command.
- Without one: the user makes a new value at the provider and saves it with `secretspec set`, with today's rotated
  date. Then publish it, and remind them to revoke the old key.
- Before an old key is revoked, ask the user to confirm nothing still uses it. A published secret isn't proof a
  deployment picked it up.
- `keypin status --json` lists every project's keys and when each is due.

Details: [How it works](https://github.com/caiopizzol/keypin/blob/main/docs/introduction/how-it-works.md),
[secretspec.toml](https://github.com/caiopizzol/keypin/blob/main/docs/reference/secretspec-toml.md),
[Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/guides/publishing.md),
[Rotating a key](https://github.com/caiopizzol/keypin/blob/main/docs/guides/rotating-a-key.md).
