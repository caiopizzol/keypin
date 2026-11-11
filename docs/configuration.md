# Configuration

Each project has a `keypin.toml` at its root. It holds names and places, never values. keypin rejects any field it
doesn't know, so a typo shows up as an error.

## Vaults

Name each 1Password vault the keys read from. The name (`personal` here) is yours to choose.

```toml
[vaults.personal]
account = "my.1password.com" # your 1Password account
vault = "Private" # the vault's name in 1Password
```

## Keys

```toml
[keys.api-token] # the key ID: lowercase letters, digits and dashes
env = "API_TOKEN" # the variable your program reads
rotate_every = "180d" # <n>d, <n>w, <n>m or never
```

A key needs at least one environment. By default these are `dev` and `prod`:

```toml
[keys.api-token.dev] # what keypin run reads
vault = "personal"
item = "my-project dev api token"

[keys.api-token.prod] # what keypin publish reads by default
vault = "personal"
item = "my-project prod api token"
```

## Environments

To use other names, list them at the top of the file. The first is what `keypin run` reads by default, and the last
is what `publish` and `rotate` use by default. `--env <name>` picks another.

```toml
environments = ["dev", "staging", "prod"]
```

Every name a key uses must be listed, so a typo such as `stagng` is an error. A name starts with a lowercase letter
and uses only lowercase letters, digits and dashes.

If two keys in the same environment set the same `env`, `keypin run` refuses to start the command.

## Destinations

Under an environment, list every place `publish` writes the key:

```toml
[[keys.api-token.prod.publish]]
to = "github-actions"
repo = "owner/repo"
account = "owner" # optional: the GitHub login that writes; defaults to the repo's owner

[[keys.api-token.prod.publish]]
to = "cloudflare-worker"
account = "<Cloudflare account ID>" # 32 hex characters
worker = "my-worker"
```

GitHub reserves secret names that start with `GITHUB_`, so a key with such an `env` can't publish to GitHub Actions.

To let `rotate` replace the key, add an `issue` section. See [Rotation](rotation.md).

## Vault items

Each 1Password item needs:

- **`password`:** the value.
- **`rotated`:** a Date field, the day the value last changed.

`keypin status` adds the key's `rotate_every` to `rotated` to show when it's due. Without a `rotate_every`, `status`
reports the key as a problem, and `rotate` refuses to run.
