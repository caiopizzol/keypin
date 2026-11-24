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
publish = [{ to = "github-actions", repo = "acme/billing" }]

[profiles.production.RESEND_API_KEY]
description = "Used by wrangler.toml"

[tool.keypin.production.RESEND_API_KEY]
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

The plan ends:

```
Plan  generation bed8b08f2e36d8ba
  + GitHub  acme/billing  first write  needs approval

This plan needs approval in a terminal; --yes can't give it.
Nothing was written: --plan only shows the plan.
To approve, run this in a terminal:
  cd /work/billing && keypin publish STRIPE_API_KEY
```

To publish, run the printed command in a terminal and answer `y`. `keypin publish --all` publishes every key with a
destination in the profile, with one plan.

Some hosts use a new value only after a redeploy; see [Publishing](../guides/publishing.md).

## Next

Each key is now in your vault and at every destination. To rotate one:

- [Rotating a key](../guides/rotating-a-key.md): give a key such as `RESEND_API_KEY` an `issuer`, and keypin makes
  the new key and publishes it to the key's destinations. keypin can't make Stripe keys: rotate `STRIPE_API_KEY` by
  hand, as that guide says.
- `keypin status` shows when each key is due, in every project.
- [Scheduled rotation](../guides/scheduled-rotation.md) rotates keys in your GitHub Actions.
