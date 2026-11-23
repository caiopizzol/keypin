# Ship to production

This page declares your production keys, puts their values in your vault, says where they go, and publishes them.

## Declare the keys and where they go

Run `keypin check`. For each secret a workflow or Worker needs, it prints the TOML to add, without the tables
`secretspec.toml` already has:

<!-- prettier-ignore -->
```toml
[profiles.production.STRIPE_API_KEY]
description = "Used by .github/workflows/deploy.yml"

[tool.keypin.production.STRIPE_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/billing" }]

[profiles.production.RESEND_API_KEY]
description = "Used by wrangler.toml"

[tool.keypin.production.RESEND_API_KEY]
rotate_every = "90d"
publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "billing-worker" }]
```

Paste it at the end of `secretspec.toml`, and replace any `<...>`. `check` finds what GitHub Actions workflows and
wrangler configs need; for other destinations, add the table yourself
([Publishing](../guides/publishing.md#destinations)). A job that runs `secretspec run` reads its keys from your vault,
so `check` doesn't ask to publish them there ([Reading keys in CI](../guides/publishing.md#reading-keys-in-ci)).

## Put each production value in your vault

- **From a file:** run `SECRETSPEC_PROFILE=production secretspec import dotenv:.env.production`, then remove the
  lines it imported.
- **A new key**, like `STRIPE_API_KEY` here: create it at the provider, then run
  `secretspec set STRIPE_API_KEY --profile production` and paste the value when it asks.

A secret that is only in GitHub or Cloudflare can't be read back, so create a new key for it too. Run
`keypin check` again: it lists the keys to publish.

## Publish

```sh
keypin publish STRIPE_API_KEY --plan
```

The plan reads:

```
STRIPE_API_KEY production  from op://Private/secretspec/billing/production/STRIPE_API_KEY/value in 1Password's default account
ok     GitHub  acme/billing  as acme, account acme

ok     Read 1 value from 1Password's default account

Plan  generation bed8b08f2e36d8ba
  + GitHub  acme/billing  first write  needs approval

This plan needs approval in a terminal; --yes can't give it.
Nothing was written: --plan only shows the plan.
To approve, run this in a terminal:
  cd /work/billing && keypin publish STRIPE_API_KEY
```

The plan shows the account keypin reached at each destination and every write; `--plan` writes nothing. To publish,
run the printed command, `keypin publish STRIPE_API_KEY`, in a terminal and answer `y`. A first write, a changed
account or a changed vault item always needs that `y` in a terminal. `keypin publish --all` publishes every key with
a destination in the profile, with one plan.

Some hosts use a new value only after a redeploy; see [Publishing](../guides/publishing.md).

## Next

- `keypin status` shows when each key is due for rotation.
- [Rotating a key](../guides/rotating-a-key.md) replaces a key at its provider and publishes the new one.
- [Scheduled rotation](../guides/scheduled-rotation.md) rotates keys in your GitHub Actions.
