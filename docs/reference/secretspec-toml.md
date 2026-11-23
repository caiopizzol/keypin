# keypin.toml

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

## Vault

The vault's table pins the account keypin reads from: `[1password]`, `[infisical]`, `[bitwarden]`, `[doppler]` or
`[awssm]`. Each vault's page lists the table's fields and the reference format:
[1Password](../integrations/vaults/1password.md), [Infisical](../integrations/vaults/infisical.md),
[Bitwarden](../integrations/vaults/bitwarden.md), [Doppler](../integrations/vaults/doppler.md) and
[AWS Secrets Manager](../integrations/vaults/aws-secrets-manager.md).

## Keys

Each `[keys.NAME]` table is named after the variable your program reads.

- `rotate_every`: how often to rotate the key, as `<n>d`, `<n>w`, `<n>m` or `never`.
- One entry per environment, `dev` and `prod` by default. Each names a reference to the value in your vault, such
  as `op://<vault>/<item>/<field>`.

Write an environment as `dev = "op://..."`, or as a `[keys.NAME.prod]` table with `from` when it also has
[destinations](../guides/publishing.md#destinations), [`pull` entries](../guides/publishing.md#pulling-in-ci) or an
[issuer](../guides/rotating-a-key.md).

## Environments

To use other names, list them at the top of the file:

```toml
environments = ["dev", "staging", "prod"]
```

`keypin run` uses the first by default and `keypin publish` the last; `--env <name>` picks another. A name starts
with a lowercase letter and uses lowercase letters, digits and dashes.

## Ignored keys

List the keys a workflow or env file names that keypin shouldn't manage, such as the optional keys of a copied
workflow. `keypin check` leaves them out, in any case, and says how many it ignores.

```toml
ignore = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
```

## Vault items

`keypin status` reads each key's rotated date, the day the value last changed, from your vault, and adds
`rotate_every` to it to show when the key is due. Each vault's page says where the date goes.

The hosted console can't read your vault. For it to show when each key is due, run `keypin status --write` in the
project and commit `.keypin/status.json`. It holds each key's `rotated` day per environment, or `null`, and the day
it was written; no values or vault references.
