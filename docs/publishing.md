# Publishing

`keypin publish <VARIABLE>` reads a key from your vault and writes it to every destination listed for it.

```sh
keypin publish API_TOKEN             # the prod entry
keypin publish API_TOKEN --env dev   # the dev entry
keypin publish --all                 # every key with prod destinations, with one approval
keypin publish API_TOKEN --plan      # show the plan, write nothing
```

## Destinations

- **GitHub Actions secrets**, written with your `gh` login: the one in `git config github.account` when it's set,
  or else the active one. That login needs write access to the repository; GitHub doesn't let read or triage
  access set secrets. See [Who publishes](configuration.md#who-publishes).
- **Cloudflare Worker secrets**, written with your `wrangler` login. The Worker must already exist. This works on
  macOS only for now, because keypin reads wrangler's login from its macOS path.

## What happens

1. **Account check:** keypin checks that each login reaches the account the map pins. If one doesn't, it stops
   before reading anything.
2. **Plan:** it reads the value and shows what it will write where. Destinations that already got this value are
   skipped.
3. **Approval:** you type `yes`. The first write to a destination, a changed account, and a changed vault item
   always need a typed `yes` in a terminal. `--yes` can approve only ordinary updates. Without a terminal,
   `publish` and `rotate` stop, print the command to run in one, and exit 3, unless `--yes` covers every step.
   When a step needs approval, they stop before reading the value, so the plan isn't shown; add `--plan` to
   see it (see [Rotation](rotation.md) for `rotate --plan`).
4. **Receipts:** each write that keypin confirms gets a receipt, with the pinned account and the login that wrote.
   A rerun skips those destinations and writes the rest, whoever runs it.

A keypin 0.6 map could pin a GitHub login as a destination's `account`, and its receipts recorded that login as
the pinned account. The account is now the repo's owner, so the first publish after you delete `account` reports
"account changed" once for those destinations and needs a typed `yes`. Receipts from maps that set only `repo`
already pinned the owner and don't change.

## See the plan first

`--plan` runs the account checks and the plan step, then stops. It works without a terminal, so an agent can
show you the plan before you approve it. It prints:

- each login's account check;
- the generation read from the vault item, which shows the item exists and is readable;
- what it would write where, and which destinations it skips because their receipt has this generation;
- each step that needs a typed `yes`, and whether `--yes` could approve the plan;
- the command that writes it.

It never writes to a destination, the vault or keypin's state, and never prints the value. It exits 3 whenever
the plan would write, even a routine plan that `--yes` could approve, and 0 when there's nothing to write.

It reads the value, so 1Password asks you to approve the command, as it does for a publish. Without `--plan`,
a publish that needs approval stops before reading anything, so you approve the 1Password read only once, in
the terminal run. `--plan` costs one more 1Password approval, in exchange for a plan you can check first.

keypin doesn't delete a secret from a destination you remove from the map. It lists that destination in the plan
instead.

## Every key at once

`keypin publish --all` (or `--all --env <name>`) publishes every key that has destinations in the environment, in
map order. It takes the same steps as one key, once for all of them:

1. It checks every account first. If any check fails, it stops before reading anything.
2. Without a terminal, if any step needs approval, it lists every approval and stops before reading any value,
   with exit 3 and the command to run in a terminal. `--all --plan` reads every value and prints the whole plan
   instead.
3. It reads each value and prints one plan for all the keys, then asks for one `yes`. `--yes` works only when no
   step of any key needs approval.
4. It writes key by key, with a receipt for each write. If a write fails, it stops, keeps the receipts so far,
   and names the keys left. Run it again to continue.

Keys with no destinations in the environment are listed and skipped. A variable name and `--all` can't be
used together.
