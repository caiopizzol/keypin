# secretspec.toml

keypin reads a project from its [`secretspec.toml`](https://secretspec.dev), in the current folder or any folder
above it. secretspec declares which secrets exist and where they live; keypin's own settings go in `[tool.keypin]`.
The file holds names and places, never values.

```toml
[project]
name = "web"
revision = "1.0"

[providers]
acme = "onepassword://my.1password.com@Acme"

[defaults]
providers = ["acme"]

[profiles.default]
STRIPE_KEY = { description = "Stripe test key" }

[profiles.production]
RESEND_API_KEY = { description = "Resend", ref = { item = "resend key", field = "credential" } }

[tool.keypin]
ignore = ["OPENAI_API_KEY"]

[tool.keypin.production.RESEND_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/web" }]
issuer = { kind = "resend", admin = "op://Acme/resend admin/credential", permission = "sending_access" }
```

## Profiles

Each secretspec profile is an environment. Every profile has the secrets of `[profiles.default]`, unless it sets
`inherit = false` under `[profiles.<name>.defaults]`, and its own entry for a secret overrides it field by field.
`keypin run` uses `default` when it's declared, else the first profile; `keypin publish` and `keypin rotate` use
`production` when it's declared, else the last. `--profile <name>` picks another. A name starts with a lowercase
letter and uses lowercase letters, digits and dashes.

## Where a secret lives

keypin reads the first provider of a secret's chain: its own `providers`, else `[profiles.<name>.defaults]`
`providers`, else `[defaults]` `providers`. An entry is an alias under `[providers]`, as a URI or a table with
`uri`, or a URI itself. An alias defined only in your own secretspec config is refused, since CI and the console
can't see it.

keypin reads 1Password from `secretspec.toml`, at `onepassword://<sign-in address>@<vault>`. The sign-in address is
at the top left of the 1Password app, such as `my.1password.com`; an account ID works too.

- With `ref = { item = "...", field = "..." }`, keypin reads that field of that item. `section` picks a field in a
  section, and `vault` overrides the URI's vault. Without `field`, it reads `value`, then `password`.
- Without `ref`, it reads secretspec's item `secretspec/<project>/<profile>/<KEY>`, field `value`, then `password`.

keypin doesn't read `refs`, a provider's `ref` template, `[project]` `extends`, or `onepassword+token://` yet.

## keypin's settings

`[tool.keypin.<profile>.<KEY>]` holds keypin's settings for a secret that profile declares:

- `rotate_every`: how often to rotate the key, as `<n>d`, `<n>w`, `<n>m` or `never`. A key rotates on one
  schedule, so set it once, or the same in every profile.
- `publish`: the [destinations](../guides/publishing.md#destinations) keypin writes the key to.
- `pull`: the [CI jobs](../guides/publishing.md#pulling-in-ci) that read it from the vault.
- `issuer`: how keypin [makes a new key](../guides/rotating-a-key.md). Its `admin` is a 1Password secret reference,
  `op://<vault>/<item>/<field>`, in the key's own account.

`ignore` lists the names a workflow or env file uses that keypin shouldn't manage. `keypin check` leaves them out,
in any case, and says how many it ignores. keypin refuses a field it doesn't know, and a `<...>` placeholder left
in a value.

## Vault items

Any field except `rotated` can hold the value. Add a **`rotated`** Date field with the day the value last changed;
`keypin status` adds `rotate_every` to it to show when the key is due.

The hosted console can't read your vault. For it to show when each key is due, run `keypin status --write` in the
project and commit `.keypin/status.json`. It holds each key's `rotated` day per profile, or `null`, and the day it
was written; no values or vault references.
