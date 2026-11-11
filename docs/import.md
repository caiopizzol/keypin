# Import

`keypin import` moves the values in an env file, such as `.env` or `.dev.vars`, into new 1Password items, and maps
each one in `keypin.toml`. Run it in the project's folder.

```sh
keypin import .env --vault Private --account my.1password.com   # a project with no map yet
keypin import .dev.vars --vault Private                         # a project whose map names its account
```

`--vault` is required. The account is the map's `[1password] account`. Without a map, give `--account`, the
account's sign-in address.

## What it creates

For each variable, a Password item named `<folder> <environment> <variable>`, such as `billing dev stripe key` for
`STRIPE_KEY`. The value goes in its `password` field, and `rotated` is today. The environment is the map's first,
`dev` by default.

It skips, and lists by name:

- a name that isn't a variable name, such as `app.key`;
- an empty value;
- a variable the map already has in that environment. One the map has only in another environment, such as `prod`,
  is left as it is too, and listed as still only in the file: add its reference by hand;
- a value with a `$`. Loaders differ: Bun expands `$OTHER` to another variable's value, and dotenv keeps it as it
  is, so keypin can't tell which value the program got. Move it by hand;
- a variable whose item already exists in the vault with another value, or can't be read. keypin never overwrites
  an item. It imports the rest, then exits 1.

An item that already exists with the same value, such as one a run stored before it stopped, isn't created again:
keypin maps it, and changes nothing in it.

## The map

Each item it creates or maps gets a key:

```toml
[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "op://Private/billing dev stripe key/password"
```

When it maps at least one key, with no `keypin.toml` or the untouched `keypin init` template, it writes a new map
with the account, and registers the project. With a real map, it adds the new keys at the end, and leaves the rest
of the file as it is. When every variable is skipped, it writes nothing. If the result wouldn't parse, it stops
before creating anything. It doesn't write through a symbolic link, or over a map that changed while it ran.

## Approval

`import` shows every item it will create and every key it will add, then waits for you to type `yes`. Without a
terminal, it stops, prints the command to run in one, and exits 3. `--yes` approves it, because it only creates new
items.

It creates the items one at a time. If one fails, it stops and maps only the items it created. Run it again to
create the rest: it skips the keys it already mapped, and maps an item it stored without mapping, because that item
holds the same value. When there's nothing new to create, it maps those items without asking.

## Afterwards

keypin never changes or deletes the env file, and it never prints a value. It names every variable still only in
the file: one that isn't a variable name, has a `$`, is mapped only in another environment, shares an item with
another, or whose item exists with another value. Move those, then delete the file and stop loading it. An empty
value or a variable the map already has in that environment needs nothing. For
example, `wrangler dev` reads `.dev.vars` (see [Notes](notes.md)). Then `keypin run -- <command>` provides the values.
