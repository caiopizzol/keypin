# Import

`keypin import` moves the values in an env file, such as `.env` or `.dev.vars`, into new 1Password items and maps
each one in `keypin.toml`.

```sh
keypin import .env --vault Private --account my.1password.com   # every variable, in a project with no account yet
keypin import .env STRIPE_KEY DATABASE_URL --vault Private      # only these two
```

Name the secrets to import. Plain settings such as `PORT` can stay in the file. `--account` is needed only while
`keypin.toml` has no `[1password]` account.

## What it does

For each variable, it creates a Password item named `<folder> <environment> <variable>`, such as `billing dev stripe
key`, with today's `rotated` date, and adds the key to `keypin.toml`:

```toml
[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "op://Private/billing dev stripe key/password"
```

A key the map already has without that environment, such as one mapped only for `prod`, gets its own table instead:

```toml
[keys.STRIPE_KEY.dev]
from = "op://Private/billing dev stripe key/password"
```

It shows every item it will create and waits for you to type `yes`. `--yes` approves it, because it only creates
items.

It never overwrites an item, and it skips, by name:

- an empty value, or a name that isn't a variable name;
- a value with a `$`, since loaders expand it differently;
- a variable `keypin.toml` already maps in that environment. It says whether the file's value matches the vault;
- a key written inline in `keypin.toml`, where a new table wouldn't parse. Add its reference by hand.

## Afterwards

keypin never changes the env file. It tells you which lines to remove, or to delete the file when nothing else is
in it. `keypin run` warns while an env file still holds a key it provides.

A `.dev.vars` has to go entirely, because while it exists `wrangler dev` ignores the keys `keypin run` provides.
Before you delete it, import every secret in it and give each plain setting a new home. See [Notes](notes.md).
