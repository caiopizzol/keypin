# Publishing

`keypin publish <VARIABLE>` reads a key from your vault and writes it to every destination listed for it.

```sh
keypin publish API_TOKEN             # the prod entry
keypin publish API_TOKEN --env dev   # the dev entry
keypin publish --all                 # every key with prod destinations, with one approval
```

## Destinations

- **GitHub Actions secrets**, written with your `gh` login. That login must be an admin of the repository.
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
4. **Receipts:** each write that keypin confirms gets a receipt. A rerun skips those destinations and writes the rest.

keypin doesn't delete a secret from a destination you remove from the map. It lists that destination in the plan
instead.

## Every key at once

`keypin publish --all` (or `--all --env <name>`) publishes every key that has destinations in the environment, in
map order. It takes the same steps as one key, once for all of them:

1. It checks every account first. If any check fails, it stops before reading anything.
2. Without a terminal, if any step needs approval, it lists every approval and stops before reading any value,
   with exit 3 and the command to run in a terminal.
3. It reads each value and prints one plan for all the keys, then asks for one `yes`. `--yes` works only when no
   step of any key needs approval.
4. It writes key by key, with a receipt for each write. If a write fails, it stops, keeps the receipts so far,
   and names the keys left. Run it again to continue.

Keys with no destinations in the environment are listed and skipped. A variable name and `--all` can't be
used together.
