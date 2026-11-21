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

`account` is the account's sign-in address, such as `my.1password.com`, its name as shown at the top left of the
1Password app, or its account ID. A team shares one account, and each member signs in to it. For other vaults,
see [Infisical](infisical.md), [Bitwarden](bitwarden.md), [Doppler](doppler.md) or
[AWS Secrets Manager](aws-secrets-manager.md).

## Keys

Each `[keys.NAME]` table is named after the variable your program reads.

- `rotate_every`: how often to rotate the key, as `<n>d`, `<n>w`, `<n>m` or `never`.
- One entry per environment, `dev` and `prod` by default. Each names a 1Password secret reference:
  `op://<vault>/<item>/<field>`, or `op://<vault>/<item>/<section>/<field>` when two fields share a name. In
  1Password, open the field's menu and select **Copy Secret Reference**. keypin reads a field's value, or the item's
  notes as `notesPlain`; not one-time passwords, files or empty values.

Write an environment as `dev = "op://..."`, or as a `[keys.NAME.prod]` table with `from` when it also has
[destinations](publishing.md#destinations), [`pull` entries](publishing.md#pulling-in-ci) or an
[issuer](rotation.md).

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

Any field except `rotated` can hold the value, such as `password` or an API Credential's `credential`. Add a
**`rotated`** Date field with the day the value last changed; `keypin status` adds `rotate_every` to it to show when
the key is due.

The hosted console can't read your vault. For it to show when each key is due, run `keypin status --write` in the
project and commit `.keypin/status.json`. It holds each key's `rotated` day per environment, or `null`, and the day
it was written; no values or vault references.

## Pulling in CI

Moved to [Publishing](publishing.md#pulling-in-ci).

## Rotating a key

Moved to [Rotation](rotation.md), with each issuer, such as <a name="neon"></a>[Neon](rotation.md#neon) and
<a name="random"></a>[`random`](rotation.md#random).
