# status

`keypin status` lists every registered project's keys, grouped under the project name, with when each is due in
words and a mark per destination, then problems (red) and notices, each with what to do next. Exit 1 if there is
a problem, 0 if only notices.

## Sub-features

- `status-rows`: `STRIPE_KEY  prod  due in 5 days   · GitHub not published`.
- `status-notices`: a due-soon notice with the rotate and publish steps; `not published yet to GitHub acme/billing`, naming places, not internal IDs.
- `status-signin`: a 1Password sign-in that fails for every key prints its error once.

## How to get to it (user POV)

- `keypin status` from any folder; it reads the registry, not the current folder.

## Driving it with drive.ts

Preconditions:

- Scenario `ready`: the prod item was rotated 85 days ago with `rotate_every = "90d"`.

- **Rows and notices.** `D status`. `due in 60 days` for dev, `due in 5 days` for prod, `2 notices`, and `not published yet to GitHub acme/billing; run keypin publish STRIPE_KEY`. No `github-actions:` in the screen. Exit 0.
- **Sign-in fails.** `D --scenario unknown-account status`. `✗ Couldn't read 2 of 2 rotated dates…`, `sign-in failed` appears exactly once, both rows say `rotation unknown`. Exit 1.

## Gotchas

- `status` only lists registered projects. The `fresh` scenario isn't registered, so status there says
  `No projects registered.`
- Dates come from `day(offset)` in `scenarios.ts`, relative to today, so the day counts stay stable.
