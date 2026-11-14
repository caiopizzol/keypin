# import, init and usage

`keypin import` moves named `.env` values into new 1Password items after a plan and a `[y/N]` prompt, and maps
them in `keypin.toml`. `keypin init` writes the template and registers the project. A mistyped command gets a
suggestion, and a usage error prints only that command's usage.

## Sub-features

- `import-plan`: the list step, `Plan` with `+ RESEND_API_KEY  op://Private/billing dev resend api key/password  create, rotated <today>`, and `Create 1 item in 1Password? [y/N]`.
- `import-yes`: `y` creates the item, maps the key, and says to remove the line from `.env`.
- `init`: `✓ wrote <sandbox>/billing/keypin.toml`, `✓ registered (1 project)`, `Next: keypin check`.
- `typo`: `keypin: unknown command "chek". Did you mean check?`, exit 2.
- `usage`: `keypin publish` with no key prints the publish usage only, exit 2.

## How to get to it (user POV)

- `keypin import .env RESEND_API_KEY --vault Private` in a project with a `.env`.
- `keypin init` in a new project.
- Any mistyped command or missing argument.

## Driving it with drive.ts

Preconditions:

- Scenarios `env-file` (a `.env` with `RESEND_API_KEY` and `PORT`) and `fresh` (an empty repository).

- **Import.** `D --scenario env-file --answer y import .env RESEND_API_KEY --vault Private`. The plan, then `Create 1 item in 1Password? [y/N] y`, `✓ Created "billing dev resend api key" in vault Private`, `✓ Mapped RESEND_API_KEY`. Exit 0. `effect: 1password create my.1password.com/Private/billing dev resend api key`. `files.json` `keypin.toml` has `[keys.RESEND_API_KEY]`; `.env` is unchanged.
- **Init.** `D --scenario fresh init`. The three lines above; `files.json` has the template `keypin.toml` and the registry lists `<sandbox>/billing`. Exit 0.
- **Typo.** `D chek`. The suggestion line and `keypin --help lists every command.` Exit 2.
- **Usage.** `D publish`. `keypin publish takes one key: the variable name, or --all`, then the two publish usage lines only. Exit 2.

## Gotchas

- import never overwrites, so `--yes` approves it; in a `--plain` drive without `--yes` it stops with exit 3.
- The `.env` value never reaches the screen; `leaks 0` proves it.
