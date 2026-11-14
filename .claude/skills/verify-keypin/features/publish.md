# publish

`keypin publish <KEY>` checks each destination's account, reads the value, prints a plan of `+`/`~`/`=` rows
with the reason for each, and, when a row needs approval, asks `Write N secrets? [y/N]`. Only `y` or `yes` in
any case writes. Anything else writes nothing and exits 3.

## Sub-features

- `publish-plan`: the header, one ✓ account line per destination, the read step, then `Plan  generation <id>` and its rows.
- `publish-yes`: `y` writes each destination once, prints `✓ GitHub  acme/billing  wrote STRIPE_KEY`, records a receipt, exits 0.
- `publish-no`: `n`, Enter, or any other text prints `Not confirmed. Nothing was written.` and exits 3.

## How to get to it (user POV)

- `keypin publish STRIPE_KEY` in a project whose `keypin.toml` publishes the key.
- `keypin publish --all` for every key with destinations.

## Driving it with drive.ts

Preconditions:

- Scenario `ready`: GitHub `acme/billing` reachable, no receipt yet, so the row is a first write that needs approval.

- **Approve.** `D --answer y publish STRIPE_KEY`. The screen shows `  + GitHub  acme/billing  first write  needs approval`, `Write 1 secret? [y/N] y`, then `✓ GitHub  acme/billing  wrote STRIPE_KEY`. Exit 0. `effect: destination write github-actions:acme/billing STRIPE_KEY (23 chars)`. `files.json` has `STRIPE_KEY` in `.local/state/keypin/state.json`.
- **Refuse.** `D --answer n publish STRIPE_KEY`, and again with `--answer ""` and `--answer yess`. `Not confirmed. Nothing was written.`, exit 3, no `effect:` line.
- **Account fails.** `D --scenario unknown-account publish STRIPE_KEY`. `✗ GitHub  acme/billing  checking the account`, then `Stopped: an account check failed. Nothing was read and nothing was written.`, no effects.

## Gotchas

- `--plain` has no terminal, so publish doesn't ask. It prints `To approve, run this in a terminal:` and
  `cd <sandbox>/billing && keypin publish STRIPE_KEY`, and exits 3. That is the agent path, not a failure.
- The fake destination records the value's length, never the value. A leak shows up as `leaks 1`.
- Every drive starts with no receipt. To see a routine `~` or `=` row, add a scenario with a `state.json` file.
