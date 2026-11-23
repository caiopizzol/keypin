# Run your app locally

This page moves the keys in your `.env` into 1Password with `keypin import`, then runs your app with them with
`keypin run`. Afterwards, no key sits in a file on your laptop.

## Move your keys into 1Password

Run the `keypin import` line `keypin check` printed, with your vault and the account's sign-in address. Here it
moves two keys from a `.env` that also sets plain settings:

```sh
keypin import .env STRIPE_KEY WEBHOOK_SECRET --vault 'App Secrets' --account my.1password.com
```

Name only the secrets. Plain settings, such as `PORT` or `PUBLIC_SITE_URL`, stay in the file. `--account` is needed
only while `keypin.toml` has no 1Password account.

`import` shows what it will create, and waits for you to answer `y`:

```
Import /work/billing/.env  into 1Password account my.1password.com, vault App Secrets
ok     Listed the items in vault App Secrets of 1Password account my.1password.com, not the values

Plan
  + STRIPE_KEY      op://App Secrets/billing dev stripe key/password      create, rotated 2026-11-09
  + WEBHOOK_SECRET  op://App Secrets/billing dev webhook secret/password  create, rotated 2026-11-09
Map: write /work/billing/keypin.toml and register /work/billing
Create 2 items in 1Password? [y/N] y

ok     Created "billing dev stripe key" in vault App Secrets
ok     Created "billing dev webhook secret" in vault App Secrets
ok     Mapped STRIPE_KEY, WEBHOOK_SECRET in /work/billing/keypin.toml
ok     registered (1 project)

The imported values are now in 1Password, and keypin run -- <command> provides them. keypin left /work/billing/.env as it is.
Remove the STRIPE_KEY, WEBHOOK_SECRET lines from it: keypin run warns while an env file holds a key it provides.
```

For each variable, it creates a Password item named `<folder> <environment> <variable>`, with a `rotated` date of
today, and maps it in `keypin.toml`:

```toml
[1password]
account = "my.1password.com"

[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "op://App Secrets/billing dev stripe key/password"

[keys.WEBHOOK_SECRET]
rotate_every = "90d"
dev = "op://App Secrets/billing dev webhook secret/password"
```

It never changes the env file, and never overwrites an item. Remove the lines it names, or delete the file when it
says nothing else is in it. [Moving off env files](../guides/moving-off-env-files.md) covers what it skips, and
importing into a map that already has keys.

`import` creates 1Password items only. With another vault, add each secret there and map it by hand; see
[Infisical](../integrations/vaults/infisical.md), [Bitwarden](../integrations/vaults/bitwarden.md),
[Doppler](../integrations/vaults/doppler.md) or [AWS Secrets Manager](../integrations/vaults/aws-secrets-manager.md).

## Run your app

Put `keypin run --` before the command that starts your app:

```sh
keypin run -- npm run dev
```

```
ok     Read 2 dev values from 1Password account my.1password.com  op://App Secrets/billing dev stripe key/password, op://App Secrets/billing dev webhook secret/password
```

`run` reads the `dev` value of each key that has one, sets it as an environment variable, and starts the command.
1Password asks you to approve keypin. To make it the default, put it in a `package.json` script:
`"dev": "keypin run -- vite"`.

- It writes nothing: not to disk, and not to `keypin.toml`. The values exist only in the command's environment,
  while it runs.
- If it can't read a key, the command doesn't start. Otherwise `run` exits with the command's own exit code.
- A variable already set in your shell gets the vault's value, with a warning.
- It warns while an env file in the project's root folder or the current folder still holds a key it provides,
  since tools differ on which value wins.
- It doesn't pass keypin's own sign-in variables, such as `OP_SERVICE_ACCOUNT_TOKEN`, to the command.

`--only NAME` passes only the keys you name, and `--env <name>` reads another environment. For `wrangler dev`,
see [Troubleshooting](../reference/troubleshooting.md#wrangler-dev): a `.dev.vars` file has to go entirely.

Next: [Ship to production](ship-to-production.md).
