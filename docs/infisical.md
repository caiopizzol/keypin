# Infisical

keypin can read keys from [Infisical](https://infisical.com) instead of 1Password. `run`, `check`, `status` and
`publish` work; `import` creates 1Password items, so add the secrets in Infisical yourself.

1. Create a [machine identity](https://infisical.com/docs/documentation/platform/identities/universal-auth) with
   Universal Auth, and add it to each project keypin reads, with read access to its environments.
2. Pin your organization in `keypin.toml`, and reference each secret by project, environment and name:

   ```toml
   [infisical]
   organization = "acme"
   url = "https://eu.infisical.com"
   
   [keys.STRIPE_KEY]
   rotate_every = "90d"
   dev = "infisical://billing/dev/STRIPE_KEY"
   prod = "infisical://billing/prod/payments/STRIPE_KEY"
   ```

   `organization` is the slug in your organization's settings. Leave out `url` for US Cloud; set it for EU Cloud or
   a self-hosted instance. `billing` is the project's slug (or its ID), `dev` the environment's slug, and folders go
   before the name.

3. Set the identity's client ID and secret on the machine:

   ```sh
   export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=...
   export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=...
   ```

keypin never passes either variable to the command `keypin run` starts. Before it reads, keypin checks that the
identity belongs to the pinned organization and refuses another.

For `keypin status`, add a `rotated` entry to each secret's metadata with the day the value last changed, as
`YYYY-MM-DD`.
