# Infisical

keypin reads secrets from [Infisical](https://infisical.com) projects. `run`, `check`, `status`, `publish` and
`rotate` work; `import` creates 1Password items, so add the secrets in Infisical yourself.

## Sign in

keypin signs in as a machine identity from your top-level organization, not a sub-organization:

- **[Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth):** set
  `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` to the identity's client ID and
  secret.
- **An access token**, for another auth method such as Kubernetes or AWS: set `INFISICAL_TOKEN` or
  `INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN`, for example to `$(infisical login --method=<method> ... --silent --plain)`.
  keypin uses the client ID and secret when both are set.
- **GitHub Actions OIDC:** see [Pulling in GitHub Actions](#pulling-in-github-actions).

keypin checks that the identity belongs to the pinned organization, and never passes these variables to the command
`keypin run` starts.

## The map

```toml
[infisical]
organization = "acme"
url = "https://eu.infisical.com"

[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "infisical://billing/dev/STRIPE_KEY"
```

| Field          | Value                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| `organization` | The slug in your organization's settings. Required.                                   |
| `url`          | Leave it out for US Cloud. Set it for EU Cloud or a self-hosted server, with no path. |

## References

A reference is `infisical://<project>/<environment>/<SECRET_NAME>`, with the project's slug or ID and the
environment's slug. Folders go before the name: `infisical://billing/prod/payments/STRIPE_KEY`.

## Rotated date

Add a `rotated` entry to the secret's metadata, with the day the value last changed as `YYYY-MM-DD`.
`keypin rotate` sets it to today.

## Permissions

Add the identity to each project keypin reads, with read access to its environments. `keypin rotate` also needs
write access.

## Pulling in GitHub Actions

A job can sign in with OIDC and read a key itself, with no stored copy or client secret. List the job in the map with
a [`pull`](../../guides/publishing.md#pulling-in-ci) entry, then:

1. Create a machine identity with [OIDC Auth](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github)
   and add it to the project with read access. Set the discovery URL and issuer to
   `https://token.actions.githubusercontent.com`, the audience to `https://github.com/<owner>`, and the subject to
   your repo's branch, such as `repo:owner@123456/repo@456789:ref:refs/heads/main`
   ([subject formats](aws-secrets-manager.md#pulling-in-github-actions)). Set **Access Token TTL** and **Access Token
   Max TTL** to a few minutes; both default to 30 days.
2. In the job, give keypin the identity's ID. keypin exchanges GitHub's token for an access token, reads, and
   revokes it before the command starts:

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
         KEYPIN_INFISICAL_IDENTITY_ID: <machine identity ID>
   ```

Set `KEYPIN_INFISICAL_AUDIENCE` if the identity expects another audience. keypin sends GitHub's token only to
Infisical Cloud; for a self-hosted `url`, also set `KEYPIN_INFISICAL_URL` to the same address.

## Limits

- keypin won't save a rotated key in a secret that references or imports another; point the map at the source.
- A self-hosted server must be from September 2025 or later.
