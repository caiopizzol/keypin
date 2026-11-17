# Doppler

keypin can read keys from [Doppler](https://www.doppler.com) instead of 1Password. `run`, `check`, `publish` and
`rotate` work; `import` creates 1Password items, so add the secrets in Doppler yourself.

1. Pin your workplace in `keypin.toml`, and reference each secret by project, config and name:

   ```toml
   [doppler]
   workplace = "2faa85f6610102d983522"
   
   [keys.STRIPE_KEY]
   rotate_every = "90d"
   dev = "doppler://billing/dev/STRIPE_KEY"
   prod = "doppler://billing/prd/STRIPE_KEY"
   ```

   `workplace` is the slug after `/workplace/` in the dashboard's address, or the one `doppler me` shows.

2. Set a token on the machine:

   ```sh
   export DOPPLER_TOKEN=dp.sa.xxxx
   ```

   - A [service account](https://docs.doppler.com/docs/service-accounts) token reads every config the account has
     access to. `keypin rotate` needs a role that can write the config.
   - A [service token](https://docs.doppler.com/docs/service-tokens) reads one config, so it suits a server or CI
     job that uses one environment. `keypin rotate` needs one made with read/write access.
   - A personal token works, but Doppler hides restricted secrets from it.

keypin never passes `DOPPLER_TOKEN` to the command `keypin run` starts. Before it reads, keypin checks that the token
belongs to the pinned workplace and refuses another.

keypin refuses to save a rotated key in a secret that references another, such as `${shared.prd.STRIPE_KEY}`, or
that a branch config's root or an inherited config also holds; point `keypin.toml` at the source secret instead.

Doppler keeps no rotated date on a secret, so `keypin status` can't tell when a Doppler key is due. To be reminded,
set a [secret reminder](https://docs.doppler.com/docs/secrets#secret-reminders) in Doppler.
