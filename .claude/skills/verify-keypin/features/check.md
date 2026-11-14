# check

`keypin check` reports a project without writing anything. With nothing to fix it prints one line:
`✓ N keys, M destinations. Everything checks out.` Otherwise it prints `N things to do, in this order:`, with
numbered steps (sign-ins first), the exact command or TOML for each, and exits 1.

## Sub-features

- `check-clear`: the all-clear line, exit 0.
- `check-steps`: numbered steps in order, each problem in one step only.
- `check-signin`: a gh login that is signed out is one `Sign in to GitHub` step, with no separate `Fix the login` step.
- `check-1password-account`: an account the 1Password app doesn't have says to set `account` under `[1password]`, and never shows the SDK's `Error { … }` text or the desktop-app settings hint.
- `check-import`: an unmapped `.env` name gets the `keypin import` command to run.

## How to get to it (user POV)

- `keypin check` in a project folder, or `keypin check <folder>`.

## Driving it with drive.ts

Preconditions:

- Scenarios `ready` and `unknown-account`.

- **All clear.** `D check`. The last line is `✓ 1 key, 1 destination. Everything checks out.` Exit 0, no effects.
- **Steps.** `D --scenario unknown-account check`. `3 things to do, in this order:`: `1 Sign in to GitHub`, `2 Sign in to 1Password`, `3 Move .env's keys into 1Password` with `keypin import .env PORT DEBUG --vault <vault>`. No `Fix the login` and no `Error {`. Exit 1.
- **Read-only.** For both drives, `effects 0`, and `files.json` shows `keypin.toml` unchanged from the scenario.

## Gotchas

- `check --json` is the agents' contract (`skills/keypin/SKILL.md`). A wording change in the text output must
  not change the JSON field names or exit codes.
- `Not checked:` lines at the end are expected when a scenario's GitHub read fails; they aren't steps.
