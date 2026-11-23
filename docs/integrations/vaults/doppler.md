# Doppler

keypin reads secrets from [Doppler](https://www.doppler.com) configs. `run`, `check`, `status`, `publish` and
`rotate` work; `import` creates 1Password items, so add the secrets in Doppler yourself.

## Sign in

Set a token on the machine:

```sh
export DOPPLER_TOKEN=dp.sa.xxxx
```

- A [service account](https://docs.doppler.com/docs/service-accounts) token reads every config the account has
  access to.
- A [service token](https://docs.doppler.com/docs/service-tokens) reads one config, so it suits a server or CI job
  that uses one environment.
- A personal token works, but Doppler hides restricted secrets from it.

In GitHub Actions, keypin can sign in with OIDC instead; see [Pulling in GitHub Actions](#pulling-in-github-actions).
keypin checks that the token belongs to the pinned workplace, and never passes `DOPPLER_TOKEN` to the command
`keypin run` starts.

## The map

```toml
[doppler]
workplace = "2faa85f6610102d983522"

[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "doppler://billing/dev/STRIPE_KEY"
```

`workplace` is the slug after `/workplace/` in the dashboard's address, or the one `doppler me` shows.

## References

A reference is `doppler://<project>/<config>/<SECRET_NAME>`, such as `doppler://billing/prd/STRIPE_KEY`.

## Rotated date

Doppler keeps no rotated date on a secret, so `keypin status` can't tell when a Doppler key is due. To be reminded,
set a [secret reminder](https://docs.doppler.com/docs/secrets#secret-reminders) in Doppler.

## Permissions

`keypin rotate` needs write access to the config: a service account role that can write it, or a service token made
with read/write access.

## Pulling in GitHub Actions

A job can sign in with OIDC and read a key itself, without a stored `DOPPLER_TOKEN`. This needs Doppler's Team or
Enterprise plan. List the job in the map with a [`pull`](../../guides/publishing.md#pulling-in-ci) entry, then:

1. On a service account that can read the config, add a
   [service account identity](https://docs.doppler.com/docs/service-account-identities). Set the discovery URL to
   `https://token.actions.githubusercontent.com`, the `aud` claim to `https://github.com/<owner>`, and the `sub` claim
   to your repo's branch, such as `repo:owner@123456/repo@456789:ref:refs/heads/main`
   ([subject formats](aws-secrets-manager.md#pulling-in-github-actions)). Keep the identity's token TTL to a few
   minutes.
2. In the job, give keypin the identity's ID, and leave `DOPPLER_TOKEN` unset. keypin exchanges GitHub's token for a
   short-lived Doppler token, reads, and tries to revoke it before the command starts:

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

Set `KEYPIN_DOPPLER_AUDIENCE` if the identity expects another audience.

## Limits

keypin won't save a rotated key in a secret that references another, such as `${shared.prd.STRIPE_KEY}`, or that a
branch config's root or an inherited config also holds; point the map at the source secret.
