# Run your app locally

`keypin import` moves the keys in your `.env` into 1Password. `keypin run` then starts your app with them.

## Import your keys

Run the import line from step 3 of `keypin check`, with your vault:

```sh
keypin import .env DATABASE_URL RESEND_API_KEY --vault Private --account my.1password.com
```

Name only the secrets; plain settings such as `PORT` stay in the file. `--account` is needed only until
`keypin.toml` has one. `import` shows its plan and asks first:

```
Plan
  + DATABASE_URL    op://Private/billing dev database url/password    create, rotated 2026-11-09
  + RESEND_API_KEY  op://Private/billing dev resend api key/password  create, rotated 2026-11-09
Map: write /work/billing/keypin.toml and register /work/billing
Create 2 items in 1Password? [y/N] y
```

It creates one item per key and maps it:

```toml
[keys.DATABASE_URL]
rotate_every = "90d"
dev = "op://Private/billing dev database url/password"
```

`import` never changes `.env`. Remove the lines its message names, and delete the file only if it says nothing else
is set in it. [Moving off env files](../guides/moving-off-env-files.md) covers the rest. `import` writes only to
1Password; with another vault, add the secrets there and map them by hand.

## Run your app

```sh
keypin run -- npm run dev
```

`run` reads each key's `dev` value and starts the command with them as environment variables. Nothing is written to
disk. If a read fails, the command doesn't start. `--only NAME` passes only the keys you name. For `wrangler dev`,
see [Troubleshooting](../reference/troubleshooting.md#wrangler-dev).
