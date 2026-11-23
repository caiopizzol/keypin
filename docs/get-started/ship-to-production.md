# Ship to production

This page puts your production keys in your vault, maps where they go, and publishes them.

## Put each prod value in your vault

- **From a file:** `keypin import .env.production RESEND_API_KEY --env prod --vault Private` adds
  `[keys.RESEND_API_KEY.prod]` to the map. Then follow its message: remove the lines it names, or delete the file
  when it says so.
- **A new key**, like `STRIPE_API_KEY` here: create it at the provider, save it in a vault item, and copy its
  reference. In 1Password, open the field's menu and select **Copy Secret Reference**.

A secret that is only in GitHub or Cloudflare can't be read back, so create a new key for it too.

## Add the destinations

Run `keypin check`. It prints the TOML to add, without the tables `keypin.toml` already has:

```
2 Add the production keys to keypin.toml
  STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing doesn't have it, and keypin.toml doesn't publish it there.
  RESEND_API_KEY: wrangler.toml requires it; the Worker billing-worker doesn't have it, and keypin.toml doesn't publish it there.
  Replace each <...> with the real value; keypin rejects a map that still has one:

[keys.STRIPE_API_KEY]
rotate_every = "90d"

[keys.STRIPE_API_KEY.prod]
from = "op://<vault>/<item>/<field>"

[[keys.STRIPE_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"

[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"
account = "11111111111111111111111111111111"
worker = "billing-worker"
```

Paste it at the end of `keypin.toml`, and replace the `<...>` with the reference you copied. `check` finds what
GitHub Actions workflows and wrangler configs need; for other destinations, add the table yourself
([Publishing](../guides/publishing.md#destinations)). Run `keypin check` again: it lists the keys to publish.

## Publish

```sh
keypin publish STRIPE_API_KEY --plan
```

```
STRIPE_API_KEY prod  from op://Private/billing prod stripe api key/password in 1Password account my.1password.com
ok     GitHub  acme/billing  as acme, account acme

Plan  generation e24c133a66cb5e4d
  + GitHub  acme/billing  first write  needs approval
```

The plan shows the account keypin reached at each destination and every write; `--plan` writes nothing. To publish,
run it again without `--plan` and answer `y`. A first write, a changed account or a changed vault item always needs
that `y` in a terminal. `keypin publish --all` publishes every key with a destination in that environment, with one
plan.

Some hosts use a new value only after a redeploy; see [Publishing](../guides/publishing.md).

## Next

- `keypin status` shows when each key is due for rotation.
- [Rotating a key](../guides/rotating-a-key.md) replaces a key at its provider and publishes the new one.
- [Pulling in CI](../guides/publishing.md#pulling-in-ci) lets a CI job read a key from your vault instead.
