# secretspec.toml

A project declares its keys in one [secretspec](https://secretspec.dev) file, `secretspec.toml`, at its root. secretspec
says which keys exist and which vault holds each one. keypin's settings sit in the same file, under `[tool.keypin]`:
where each key is published and how it's rotated. The file holds names and places, never values. keypin looks for it
in the current folder, then in each folder above.

```toml
[project]
name = "web"
revision = "1.0"

[providers]
acme = "onepassword://Acme"

[defaults]
providers = ["acme"]

[profiles.default]
STRIPE_KEY = { description = "Stripe test key" }

[profiles.production]
RESEND_API_KEY = { description = "Resend", ref = { item = "resend key", field = "credential" } }

[tool.keypin]
ignore = ["KEYPIN_GITHUB_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN"]

[tool.keypin.production.RESEND_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/web" }]
issuer = { kind = "resend", admin = "op://Acme/resend admin/credential", permission = "sending_access" }
```

`secretspec init` writes the file, and `secretspec add` declares a key. For `[project]`, `[providers]`, `[defaults]`
and `[profiles]`, see secretspec's [configuration reference](https://secretspec.dev/reference/configuration/). This
page covers what keypin reads from them, and `[tool.keypin]`.

## Profiles

keypin uses secretspec's profiles, in the order the file first names them; a `[profiles.<name>.defaults]` table
names its profile too. Every profile also has the keys of `[profiles.default]`, unless it sets `inherit = false` under
`[profiles.<name>.defaults]`, and a profile's own entry for the same name overrides it field by field. In the example,
`production` has both `STRIPE_KEY` and `RESEND_API_KEY`.

`keypin publish` and `keypin rotate` use `production`, or the last profile if the file has no `production`.
`--profile <name>` picks another. keypin needs a profile name that starts with a lowercase letter and uses only
lowercase letters, digits and dashes.

## Where each value lives

For a key in a profile, keypin uses the first provider it finds in the key's own `providers`, then in
`[profiles.<name>.defaults]` `providers`, then in `[defaults]` `providers`.

A provider is an alias from the file's `[providers]` table, written as a URI or as a table with `uri`, or a URI
written in place. keypin refuses an alias that only your own `~/.config/secretspec/config.toml` defines, and a key
with no provider: CI and the hosted console read only the committed file, so they couldn't find the vault.
`keypin check` prints the `[providers]` and `[defaults]` lines to add.

Without `ref`, a key's value is where secretspec keeps it. With `ref = { item = "..." }`, keypin reads the secret
you name, as secretspec does. Each vault's page has its URI, both addresses and what keypin refuses:

| Vault                                                                | Provider URI                        |
| -------------------------------------------------------------------- | ----------------------------------- |
| [1Password](../integrations/vaults/1password.md)                     | `onepassword://[<account>@]<vault>` |
| [Infisical](../integrations/vaults/infisical.md)                     | `infisical://<host>/<project ID>`   |
| [Bitwarden Secrets Manager](../integrations/vaults/bitwarden.md)     | `bws://[<server>@]<project ID>`     |
| [Doppler](../integrations/vaults/doppler.md)                         | `doppler://<project>[/<config>]`    |
| [AWS Secrets Manager](../integrations/vaults/aws-secrets-manager.md) | `awssm://<region>`                  |

keypin doesn't read a secret's `refs`, a provider's `ref` template, or `[project]` `extends` yet. It skips a secret
with `from` or `composed`: no vault holds it, so there's nothing to publish or rotate.

## [tool.keypin]

secretspec leaves this table alone. Don't put keypin's fields in a key's entry under `[profiles]`: secretspec warns
about them and drops them.

- `ignore`: keys a workflow or env file names that keypin shouldn't manage, such as the optional keys of a copied
  workflow. `keypin check` leaves them out, in any profile and any case, and says how many it ignores.

Each `[tool.keypin.<profile>.<KEY>]` table sets one key in one profile. The key must be declared in that profile or
in `[profiles.default]`.

- `rotate_every`: how often to rotate the key, as `<n>d`, `<n>w`, `<n>m` or `never`. A key has one schedule, so
  keypin refuses different values in two profiles.
- `publish`: where `keypin publish` writes the key. See [Destinations](../guides/publishing.md#destinations).
- `issuer`: how `keypin rotate` makes a new key. See [Rotating a key](../guides/rotating-a-key.md).

An issuer's `admin` is not a provider URI. It's a reference in keypin's own syntax to one secret in the key's own
vault, such as `op://Acme/resend admin/credential`. Infisical, Doppler and AWS Secrets Manager references start with
the same scheme as their provider URIs but name a single secret, as `infisical://<project>/<environment>/<NAME>`,
`doppler://<project>/<config>/<NAME>` or `awssm://<region>/<secret name>`. The admin key isn't a declared key, so
`secretspec run` never passes it to your app.

keypin refuses a field it doesn't know and a `<...>` placeholder left in a value, and names the table, such as
`[tool.keypin.production.RESEND_API_KEY]`.

## Vault items

Each vault keeps a key's rotated date its own way; see its page. `keypin status` adds `rotate_every` to it to show
when the key is due, and `keypin rotate` sets it. secretspec reads the value and leaves the date alone.

The hosted console can't read your vault. For it to show when each key is due, run `keypin status --write` in the
project and commit `.keypin/status.json`. It holds each key's rotated day per profile, or `null`, and the day it
was written; no values or vault references.
