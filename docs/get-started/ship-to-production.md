# Ship to production

This page puts your production keys in your vault, lists where each one goes, and publishes them with
`keypin publish`. You see a plan before anything is written.

## Put each prod value in your vault

`publish` reads each key's `prod` value from your vault. It can be a different item from the `dev` one, so your
laptop never needs the production value to run the app.

- **In a file**, such as `.env.production`: import it for the `prod` environment.

  ```sh
  keypin import .env.production STRIPE_API_KEY --env prod --vault Private
  ```

  It maps the key's `prod` entry as a table, `[keys.STRIPE_API_KEY.prod]`, ready for its destinations.

- **Only in GitHub or Cloudflare:** neither keypin nor you can read a secret back from them. Make a new key at the
  provider, put it in a vault item, and copy its reference. In 1Password, open the field's menu and select
  **Copy Secret Reference**.

## Add the destinations

Run `keypin check`. For each secret a workflow or Worker needs and doesn't have, it prints the TOML to add, as in
[Your first project](your-first-project.md#check-the-project). Paste it into `keypin.toml` and replace each `<...>`:

```toml
[keys.STRIPE_API_KEY]
rotate_every = "90d"

[keys.STRIPE_API_KEY.prod]
from = "op://Private/billing prod stripe api key/password"

[[keys.STRIPE_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"

[keys.RESEND_API_KEY.prod]
from = "op://Private/billing prod resend api key/password"

[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"
account = "11111111111111111111111111111111"
worker = "billing-worker"
```

`check` finds what GitHub Actions workflows and wrangler configs need. For Vercel, Supabase, Netlify, Railway,
Convex, Fly.io and GitLab, add the table yourself; [Publishing](../guides/publishing.md#destinations) lists each
destination's fields and the login it uses.

Run `keypin check` again. Once the map is complete, it lists what to publish, after any login you still need:

```
billing /work/billing · read 1 env file, 1 wrangler config, 1 workflow; GitHub acme/billing
2 things to do, in this order:
1 Sign in to Cloudflare
    wrangler login
  Or set KEYPIN_CLOUDFLARE_API_TOKEN to a Cloudflare API token.
2 Publish 2 keys
  STRIPE_API_KEY: keypin.toml publishes it to acme/billing, which doesn't have it yet.
  RESEND_API_KEY: keypin.toml publishes it to the Worker billing-worker, which doesn't have it yet.
    keypin publish STRIPE_API_KEY
    keypin publish RESEND_API_KEY
```

## See the plan

```sh
keypin publish STRIPE_API_KEY --plan
```

```
STRIPE_API_KEY prod  from op://Private/billing stripe api key/password in 1Password account my.1password.com
ok     Cloudflare  billing-worker  as me@example.com, account 11111111111111111111111111111111
ok     GitHub      acme/billing    as acme, account acme

ok     Read 1 value from 1Password account my.1password.com

Plan  generation 8f24c3e0b75826a7
  + Cloudflare  billing-worker  first write  needs approval
    writing a Worker secret deploys a new version of the Worker
  + GitHub      acme/billing    first write  needs approval

This plan needs approval in a terminal; --yes can't give it.
Nothing was written: --plan only shows the plan.
To approve, run this in a terminal:
  cd /work/billing && keypin publish STRIPE_API_KEY
```

- **The account lines** show who keypin signs in as at each destination, and the account it reaches. It stops if
  one isn't the account the map pins.
- **`generation`** is a short hash of the value, not the value. keypin records it to tell whether a destination
  already has this value.
- **The plan** shows each write. A first write to a destination, a changed account or a changed vault item needs
  your `y` in a terminal.

`--plan` reads the value, so 1Password asks you to approve it, but it never writes or prints one. It exits 3 when
the plan would write, and 0 when there's nothing to write.

## Publish

```sh
keypin publish STRIPE_API_KEY
```

It runs the same checks and shows the same plan, then asks before it writes:

```
Write 2 secrets? [y/N] y
ok     Cloudflare  billing-worker  wrote STRIPE_API_KEY
ok     GitHub      acme/billing    wrote STRIPE_API_KEY
Published STRIPE_API_KEY (prod) to 2 destinations.
```

`keypin publish --all` publishes every key that has destinations, with one plan and one approval.

keypin records a receipt for each write in `~/.local/state/keypin/state.json`, so a rerun skips the destinations
that already have the value. A teammate's machine has no receipts, so their first publish counts as a first write.

Some destinations use a new value only after a deploy, such as Vercel, Netlify, Railway and Fly.io; keypin doesn't
deploy. See [Publishing](../guides/publishing.md) for each one.

## Next

- `keypin status` lists every registered project's keys and when each is due for rotation.
- [Rotating a key](../guides/rotating-a-key.md) replaces a key at its provider and publishes the new one.
- [Pulling in CI](../guides/publishing.md#pulling-in-ci) lets a CI job read a key from your vault instead of a
  published copy.
