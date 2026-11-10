# Publishing

`keypin publish <key-id>` reads a key from your vault and writes it to every destination listed for it.

```sh
keypin publish api-token             # the prod entry
keypin publish api-token --env dev   # the dev entry
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
   always need a typed `yes` in a terminal. `--yes` can approve only ordinary updates.
4. **Receipts:** each write that keypin confirms gets a receipt. A rerun skips those destinations and writes the rest.

keypin doesn't delete a secret from a destination you remove from the map. It lists that destination in the plan
instead.
