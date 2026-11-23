# Your first project

`secretspec init` writes `secretspec.toml`. `keypin check` reports what the project uses and what to do next. By the
end of [Ship to production](ship-to-production.md), each key is in your vault and keypin can publish it everywhere
it's used. Rotating a key takes an [issuer](../guides/rotating-a-key.md) too.

## Declare the keys

In the project's root folder:

```sh
secretspec init
```

It declares each name in `.env` under `[profiles.default]`, with no values. Delete the ones that aren't keys, such as
`PORT`. See secretspec's [quick start](https://secretspec.dev/quick-start/).

## Check the project

```sh
keypin check
```

`check` reads env files, wrangler configs and GitHub Actions workflows. It looks up each key's vault item, not its
value, and the secret names at each destination. It writes nothing, and adds the project to `keypin status`.

Here `secretspec init` declared the two keys `.env` sets, a workflow uses `STRIPE_API_KEY` and the Worker requires
`RESEND_API_KEY`:

```
billing /work/billing · read 1 env file, 1 wrangler config, 1 workflow; GitHub acme/billing
4 things to do, in this order:
1 Sign in to Cloudflare
    wrangler login
  Or set KEYPIN_CLOUDFLARE_API_TOKEN to a Cloudflare API token.
2 Set up 1Password
  keypin needs the 1Password desktop app, with Settings → Developer → Integrate with other apps selected.
3 Fix /work/billing/secretspec.toml
  /work/billing/secretspec.toml: [profiles.default] DATABASE_URL: names no provider in secretspec.toml, so CI and the console can't find its vault; add providers = ["..."] to it, or set [defaults] providers
  /work/billing/secretspec.toml: [profiles.default] RESEND_API_KEY: names no provider in secretspec.toml, so CI and the console can't find its vault; add providers = ["..."] to it, or set [defaults] providers
4 Name the vault in secretspec.toml
  A secret's provider in secretspec.toml names its vault, so secretspec, CI and the console find it there.
  Replace each <...> with the real value; keypin rejects a secretspec.toml that still has one:

[providers]
onepassword = "onepassword://<vault>"

[defaults]
providers = ["onepassword"]

  Then run keypin check again.
```

Do the steps in order:

1. Set up the logins and apps; you do these, not keypin.
2. Add the `[providers]` and `[defaults]` lines, with your 1Password vault's name in place of `<vault>`. To name
   the account too, write `onepassword://<sign-in address>@<vault>`. Other vaults have their own URI; see
   [secretspec.toml](../reference/secretspec-toml.md#where-each-value-lives). Add an empty `[profiles.production]`
   too: keypin publishes from it.
3. Move the keys in `.env`: [Run your app locally](run-your-app-locally.md).
4. Add the production keys: [Ship to production](ship-to-production.md).

A `Not checked:` line means `check` couldn't read something: it's unverified, not missing. Run `keypin check` again
after each change; it exits 0 when everything checks out. `--json` prints the report for scripts and agents.
