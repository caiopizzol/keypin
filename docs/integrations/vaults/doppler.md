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

   In a GitHub Actions job, keypin can sign in with OIDC instead; see
   [Pulling in GitHub Actions](#pulling-in-github-actions).

keypin never passes `DOPPLER_TOKEN` to the command `keypin run` starts. Before it reads, keypin checks that the token
belongs to the pinned workplace and refuses another.

keypin refuses to save a rotated key in a secret that references another, such as `${shared.prd.STRIPE_KEY}`, or
that a branch config's root or an inherited config also holds; point `keypin.toml` at the source secret instead.

Doppler keeps no rotated date on a secret, so `keypin status` notes it can't tell when a Doppler key is due. To be
reminded, set a [secret reminder](https://docs.doppler.com/docs/secrets#secret-reminders) in Doppler.

## Pulling in GitHub Actions

A GitHub Actions job can sign in to Doppler with OIDC and read a key itself, without a stored `DOPPLER_TOKEN`. This
needs Doppler's Team or Enterprise plan. List the job in the map with a [`pull`](publishing.md#pulling-in-ci)
entry, then:

1. On a service account that can read the config, add a
   [service account identity](https://docs.doppler.com/docs/service-account-identities). Set the discovery URL to
   `https://token.actions.githubusercontent.com`, the `aud` claim to `https://github.com/<owner>`, and the `sub`
   claim to the one GitHub gives your repo's branch, such as `repo:owner@123456/repo@456789:ref:refs/heads/main`.
   See [the subject formats](aws-secrets-manager.md#pulling-in-github-actions) for older repos and GitHub
   environments. Keep the identity's token TTL to a few minutes.

2. In the job, give keypin the identity's ID. keypin exchanges GitHub's token for a short-lived Doppler token,
   reads, and tries to revoke it before the command starts; if that fails, keypin warns and starts the command
   anyway, and the token lasts until its TTL runs out:

   ```yaml
   permissions:
     id-token: write
     contents: read
   steps:
     - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
     - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
       with:
         node-version: 24
     - run: npm install -g keypin
     - run: keypin run --env prod --only STRIPE_KEY -- <command>
       env:
         KEYPIN_DOPPLER_IDENTITY_ID: <identity ID>
   ```

   Set `KEYPIN_DOPPLER_AUDIENCE` if the identity expects another audience. Leave `DOPPLER_TOKEN` unset; keypin
   refuses both. `keypin check` flags a job that sets the ID without `id-token: write`.
