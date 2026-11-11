# Configuration

Each project has a `keypin.toml` at its root. It holds names and places, never values. keypin rejects any field it
doesn't know, so a typo shows up as an error.

A `keypin.toml` from keypin 0.4 (with `[vaults]`, `env`, `vault` and `item`) doesn't parse any more. Rewrite it in
the format below.

## 1Password account

```toml
[1password]
account = "my.1password.com" # its sign-in address, as at the top left of the 1Password app, or its account ID
```

Commit it. A team shares one account, such as a 1Password Teams or Business account, and every member signs in to
it.

## Keys

```toml
[keys.API_TOKEN] # the variable your program reads
rotate_every = "180d" # <n>d, <n>w, <n>m or never
```

A key needs at least one environment. By default these are `dev` and `prod`. Each one names the value with a
1Password secret reference, `op://<vault>/<item>/<field>`, or `op://<vault>/<item>/<section>/<field>` when two
fields share a name. Copy it from 1Password: open the item, select the field's menu, then **Copy Secret Reference**.

```toml
dev = "op://Private/my-project dev api token/credential" # what keypin run reads

[keys.API_TOKEN.prod] # what keypin publish reads by default
from = "op://Private/my-project prod api token/credential"
```

Use the short form, `dev = "op://..."`, when the environment has nothing else. Use a table with `from` when it
also has destinations or an `issue` section.

## Environments

To use other names, list them at the top of the file. The first is what `keypin run` reads by default, and the last
is what `publish` and `rotate` use by default. `--env <name>` picks another.

```toml
environments = ["dev", "staging", "prod"]
```

Every name a key uses must be listed, so a typo such as `stagng` is an error. A name starts with a lowercase letter
and uses only lowercase letters, digits and dashes.

## Destinations

Under an environment, list every place `publish` writes the key:

```toml
[[keys.API_TOKEN.prod.publish]]
to = "github-actions"
repo = "owner/repo"
account = "owner" # optional: the GitHub login that writes; defaults to the repo's owner

[[keys.API_TOKEN.prod.publish]]
to = "cloudflare-worker"
account = "<Cloudflare account ID>" # 32 hex characters
worker = "my-worker"
```

GitHub reserves secret names that start with `GITHUB_`, so a key with such a name can't publish to GitHub Actions.

To let `rotate` replace the key, add an `issue` section. See [Rotation](rotation.md).

## Vault items

The reference's field holds the value. Any field works, such as `password` or an API Credential item's
`credential`, except `rotated`. Add a **`rotated`** Date field, the day the value last changed.

`keypin status` adds the key's `rotate_every` to `rotated` to show when it's due. Without a `rotate_every`, `status`
reports the key as a problem, and `rotate` refuses to run.

When `rotate` stores a new value in an item that doesn't exist yet, it creates a Password item. That works only
for a reference to its `password` field. For any other field, create the item first.
