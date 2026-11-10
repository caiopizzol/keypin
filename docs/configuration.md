# Configuration

Each project has a `keypin.toml` at its root. It holds names and places, never values. keypin rejects any field it
doesn't know, so a typo shows up as an error.

## Vaults

Name each 1Password vault the keys read from. The name (`personal` here) is yours to choose.

```toml
[vaults.personal]
kind = "1password" # the only kind for now
account = "my.1password.com" # your 1Password account
vault = "Private" # the vault's name in 1Password
```

## Keys

```toml
[keys.api-token] # the key ID: lowercase letters, digits and dashes
env = "API_TOKEN" # the variable your program reads
owner = "my-project"
rotate_every = "180d" # optional; overrides the vault item's rotate_every
```

A key needs at least one environment, `dev` or `prod`:

```toml
[keys.api-token.dev] # what keypin run reads
vault = "personal"
item = "my-project dev api token"

[keys.api-token.prod] # what keypin publish reads by default
vault = "personal"
item = "my-project prod api token"
```

## Destinations

Under an environment, list every place `publish` writes the key:

```toml
[[keys.api-token.prod.publish]]
to = "github-actions"
repo = "owner/repo"
account = "owner" # optional: the GitHub login that writes; defaults to the repo's owner

[[keys.api-token.prod.publish]]
to = "cloudflare-worker"
account = "<Cloudflare account ID>"
worker = "my-worker"
```

GitHub reserves secret names that start with `GITHUB_`, so a key with such an `env` can't publish to GitHub Actions.

To let `rotate` replace the key, add an `issue` section. See [Rotation](rotation.md).

## Vault items

Each 1Password item needs:

- **`password`:** the value.
- **`rotated`:** a Date field, the day the value last changed.
- **`rotate_every`:** a Text field: `<n>d`, `<n>w`, `<n>m` or `never`. A `rotate_every` in `keypin.toml` takes
  precedence.

`keypin status` uses the last two to show when each key is due.
