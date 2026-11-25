# secretspec.toml

Every field keypin reads from `secretspec.toml`, the [secretspec](https://secretspec.dev) file at a project's root.
keypin's own settings sit under `[tool.keypin]`. keypin looks for the file in the current folder, then in each folder
above.

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

For `[project]`, `[providers]`, `[defaults]` and `[profiles]`, see secretspec's
[configuration reference](https://secretspec.dev/reference/configuration/).

## Profiles

keypin uses secretspec's profiles, in the order the file first names them; a `[profiles.<name>.defaults]` table
names its profile too. Every profile also has the keys of `[profiles.default]`, unless it sets `inherit = false` under
`[profiles.<name>.defaults]`, and a profile's own entry for the same name overrides it field by field. In the example,
`production` has both `STRIPE_KEY` and `RESEND_API_KEY`.

`keypin publish` and `keypin rotate` use `production`, or the last profile if the file has no `production`.
`--profile <name>` picks another. A profile name starts with a lowercase letter and uses only lowercase letters,
digits and dashes.

## Where each value lives

For a key in a profile, keypin uses the first provider it finds in the key's own `providers`, then in
`[profiles.<name>.defaults]` `providers`, then in `[defaults]` `providers`.

A provider is an alias from the file's `[providers]` table, written as a URI or as a table with `uri`, or a URI
written in place. Define it in `secretspec.toml`, not only in your own `~/.config/secretspec/config.toml`: CI and the
hosted console read only the committed file.

Without `ref`, a key's value is where secretspec keeps it. With `ref = { item = "..." }`, keypin reads the secret
you name, as secretspec does. Each vault's page has its URI and both addresses:

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

secretspec leaves this table alone.

- `ignore`: keys a workflow or env file names that keypin shouldn't manage, such as the optional keys of a copied
  workflow. `keypin check` leaves them out, in any profile and any case. When it reads every file, it names any
  that had no effect.
- `scan_files`: in a monorepo, the workflows and wrangler configs this project owns, as globs from the repo root,
  such as `[".github/workflows/billing-*.yml", "apps/billing/wrangler.toml"]`. `keypin check` reports keys only
  from those and from env files in the project's folder. Without it, check reads every workflow and the wrangler
  configs in the project's folder. `[]` owns none.

Each `[tool.keypin.<profile>.<KEY>]` table sets one key in one profile. The key must be declared in that profile or
in `[profiles.default]`.

- `rotate_every`: how often to rotate the key, as `<n>d`, `<n>w`, `<n>m` or `never`. A key has one schedule across
  profiles.
- `publish`: where `keypin publish` writes the key. See [Destinations](../guides/publishing.md#destinations).
- `issuer`: how `keypin rotate` makes a new key. See [Rotating a key](../guides/rotating-a-key.md).
- `name`: what the provider calls each new key, before a six-character tag that's new each run: `name = "web-mail"`
  makes `web-mail-cfe159`. Use lowercase letters, digits and `-`. Without it, the name is the project, key and
  profile: `web-resend-api-key-production-cfe159`. Where the provider allows fewer characters, keypin shortens the
  part before the tag. Neon, AWS, MongoDB Atlas and Google Cloud service account keys take no name.

An issuer's `admin` is not a provider URI. It's a reference in keypin's own syntax to one secret in the key's own
vault, such as `op://Acme/resend admin/credential`; each vault's page has its form. The admin key isn't a declared
key, so `secretspec run` never passes it to your app.

## Vault items

Each vault keeps a key's rotated date its own way; see its page. `keypin status` adds `rotate_every` to it to show
when the key is due, and `keypin rotate` sets it. secretspec reads the value and leaves the date alone.

The hosted console can't read your vault. For it to show when each key is due, run `keypin status --write` in the
project and commit `.keypin/status.json`, which holds each key's rotated day per profile and no values.
