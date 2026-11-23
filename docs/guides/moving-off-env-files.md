# Moving off env files

secretspec moves the values in an env file, such as `.env` or `.dev.vars`, into your vault, and runs your app with
them. `keypin check` lists the names each env file sets that `secretspec.toml` doesn't declare, and the commands to
move them.

1. Declare the file's keys. In a project without a `secretspec.toml`, `secretspec init` declares every name in
   `.env` under `[profiles.default]`, with no values; delete the plain settings, such as `PORT`, which can stay in the
   file. Otherwise, run `secretspec add <NAME>` for each key not declared yet.

2. Name the vault, if `secretspec.toml` has no provider yet. `keypin check` prints the lines to add:

   ```toml
   [providers]
   acme = "onepassword://Acme"
   
   [defaults]
   providers = ["acme"]
   ```

3. Copy the values into the vault:

   ```sh
   secretspec import dotenv:.env
   ```

   It copies each declared key's value, such as into the 1Password item `secretspec/web/default/STRIPE_KEY`. For
   another profile's file, declare its keys under that profile, then run
   `SECRETSPEC_PROFILE=production secretspec import dotenv:.env.production`.

4. Give each key a rotated date, so `keypin status` can tell when it's due. See your vault's page, such as
   [1Password](../integrations/vaults/1password.md#rotated-date).

5. Run your app with `secretspec run -- <command>`.

See secretspec's [import reference](https://secretspec.dev/reference/cli/#import) for what `import` skips and
reports.

## Afterwards

Neither tool changes the env file. Remove each line you imported, or delete the file when nothing else is in it.
`keypin check` warns when git tracks an env file, since its values may be committed.

A `.dev.vars` has to go entirely, because while it exists `wrangler dev` ignores the keys `secretspec run` provides.
Before you delete it, move every secret in it to your vault and give each plain setting a new home. See
[`wrangler dev`](../reference/troubleshooting.md#wrangler-dev).
