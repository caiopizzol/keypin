# Your first project

`secretspec init` writes `secretspec.toml`. `keypin check` reports what the project uses and what to do next.

## Declare the keys

In the project's root folder:

```sh
secretspec init
```

It writes `secretspec.toml`, with an entry for each name in `.env` if there is one, and no values. See secretspec's
[quick start](https://secretspec.dev/quick-start/).

## Check the project

```sh
keypin check
```

`check` reads env files, wrangler configs and GitHub Actions workflows. It looks up each key's vault item, not its
value, and the secret names at each destination. It writes nothing, and adds the project to `keypin status`.

Here `secretspec.toml` declares no key yet; `.env` sets two, a workflow uses `STRIPE_API_KEY` and the Worker requires
`RESEND_API_KEY`:

```
billing /work/billing · read 2 env files, 1 wrangler config, 1 workflow; GitHub acme/billing
5 things to do, in this order:
1 Sign in to Cloudflare
    wrangler login
  Or set KEYPIN_CLOUDFLARE_API_TOKEN to a Cloudflare API token.
2 Set up 1Password
  keypin needs the 1Password desktop app, with Settings → Developer → Integrate with other apps selected.
3 Name the vault in secretspec.toml
  A secret's provider in secretspec.toml names its vault, so secretspec, CI and the console find it there.
  Replace each <...> with the real value; keypin rejects a map that still has one:

[providers]
onepassword = "onepassword://<vault>"

[defaults]
providers = ["onepassword"]

4 Move .env's keys into your vault
  .env sets DATABASE_URL, RESEND_API_KEY, which secretspec.toml doesn't declare.
    secretspec add DATABASE_URL
    secretspec add RESEND_API_KEY
    secretspec import dotenv:.env
  Leave out a name that isn't a key: secretspec import copies only declared names, and the file stays.
5 Add the production keys to secretspec.toml
  STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing doesn't have it, and secretspec.toml doesn't publish it there.
  RESEND_API_KEY: wrangler.toml requires it; the Worker billing-worker doesn't have it, and secretspec.toml doesn't publish it there.
  If you ran the commands above, run keypin check again for this TOML instead; secretspec add changes secretspec.toml.
  Add this at the end of secretspec.toml:

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

  Then run keypin check again.
```

Do the steps in order:

1. Set up the logins and apps; you do these, not keypin.
2. Add the `[providers]` and `[defaults]` lines, with your 1Password vault's name in place of `<vault>`. To name
   the account too, write `onepassword://<sign-in address>@<vault>`. Other vaults have their own URI; see
   [secretspec.toml](../reference/secretspec-toml.md#where-each-value-lives).
3. Move the keys in `.env`: [Run your app locally](run-your-app-locally.md).
4. Add the production keys: [Ship to production](ship-to-production.md).

A `Not checked:` line means `check` couldn't read something: it's unverified, not missing. Run `keypin check` again
after each change; it exits 0 when everything checks out. `--json` prints the report for scripts and agents.
