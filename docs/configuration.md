# Configuration

Each project has a `keypin.toml` at its root. It holds names and places, never values. keypin rejects a field it
doesn't know, and a `<...>` placeholder left in a value.

```toml
[1password]
account = "my.1password.com"

[keys.API_TOKEN]
rotate_every = "90d"
dev = "op://Private/my-project dev api token/credential"

[keys.API_TOKEN.prod]
from = "op://Private/my-project prod api token/credential"

[[keys.API_TOKEN.prod.publish]]
to = "github-actions"
repo = "me/my-project"
```

## 1Password account

`account` is the account's sign-in address, as shown at the top left of the 1Password app, or its account ID. A team
shares one account, and each member signs in to it.

## Keys

Each `[keys.NAME]` table is named after the variable your program reads.

- `rotate_every`: how often to rotate the key, as `<n>d`, `<n>w`, `<n>m` or `never`. `keypin status` uses it to
  show when the key is due.
- One entry per environment, `dev` and `prod` by default. Each names a 1Password secret reference:
  `op://<vault>/<item>/<field>`, or `op://<vault>/<item>/<section>/<field>` when two fields share a name. In
  1Password, open the field's menu and select **Copy Secret Reference**.

Write an environment as `dev = "op://..."`, or as a `[keys.NAME.prod]` table with `from` when it also has
destinations.

## Environments

To use other names, list them at the top of the file:

```toml
environments = ["dev", "staging", "prod"]
```

`keypin run` uses the first by default and `keypin publish` the last; `--env <name>` picks another. A name starts
with a lowercase letter and uses lowercase letters, digits and dashes.

## Destinations

List each place `publish` writes the key under its environment. `keypin check` prints these for each secret a
workflow or Worker needs.

```toml
[[keys.API_TOKEN.prod.publish]]
to = "github-actions"
repo = "owner/repo"

[[keys.API_TOKEN.prod.publish]]
to = "cloudflare-worker"
account = "<Cloudflare account ID>"
worker = "my-worker"
```

GitHub reserves secret names that start with `GITHUB_`.

The map says where a key goes, not who writes it, so every teammate publishes from the same map:

- **GitHub:** the login in `git config github.account`, or else the active `gh` login. It needs write access to the
  repo.
- **Cloudflare:** the `wrangler` login. It must reach the pinned `account`.

## Vault items

Any field can hold the value, such as `password` or an API Credential's `credential`. Add a **`rotated`** Date field
with the day the value last changed; `keypin status` adds `rotate_every` to it to show when the key is due.

To rotate a key, put the new value in the field, set `rotated` to today, then run `keypin publish <VARIABLE>`.
