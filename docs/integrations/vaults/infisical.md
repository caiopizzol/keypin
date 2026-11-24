# Infisical

keypin reads and rotates keys in [Infisical](https://infisical.com) projects. `check`, `status`, `publish` and
`rotate` work.

## Sign in

keypin signs in as a machine identity:

- **[Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth):** set
  `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` to the identity's client ID and
  secret.
- **An access token**, for another auth method such as Kubernetes or AWS: set `INFISICAL_TOKEN` or
  `INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN`, for example to `$(infisical login --method=<method> ... --silent --plain)`.
  keypin uses the client ID and secret when both are set.
- **GitHub Actions OIDC:** see [Signing in from GitHub Actions](#signing-in-from-github-actions).

secretspec reads `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` instead; only `INFISICAL_TOKEN` works for both.

## The provider

```toml
[project]
name = "billing"

[providers]
infisical = "infisical://app.infisical.com/7e2f1a4c-0b1d-4c8e-9f00-1234567890ab"
infisical_eu = "infisical://eu.infisical.com/7e2f1a4c-0b1d-4c8e-9f00-1234567890ab?env=prod&path=/apps"

[defaults]
providers = ["infisical"]

[profiles.production]
STRIPE_KEY = { description = "Stripe" }
RESEND_API_KEY = { description = "Resend", ref = { item = "/billing/RESEND" } }
SENTRY_DSN = { description = "Sentry", providers = ["infisical_eu"] }
```

The provider is `infisical://<host>/<project ID>`, with the server's host, such as `app.infisical.com`,
`eu.infisical.com` or your own, and the project ID from the project's settings. `?env=<slug>` names the environment;
without it, the profile does. `?path=<folder>` sets the folder secretspec keeps its secrets under, `/secretspec` by
default.

Write the host in the URI: CI and the console can't see the `INFISICAL_DOMAIN` secretspec would use. keypin signs in
only over https, so it refuses `tls=false`.

## Addresses

- **Without `ref`:** the secret `<KEY>` in the folder `<path>/<project>/<profile>`. In the example,
  `STRIPE_KEY` is in `/secretspec/billing/production`, environment `production`, and `SENTRY_DSN` in
  `/apps/billing/production`, environment `prod`.
- **With `ref`:** `item` is the secret's name, with its folder before it. `/billing/RESEND` is `RESEND` in
  `/billing`; `team/RESEND` is in `<path>/team`; a bare `RESEND` is in `<path>`.

An issuer's `admin` is a reference in keypin's own syntax, not a provider URI: `infisical://<project>/<environment>/<NAME>`,
with the project's slug or ID and any folders before the name. keypin reads it from the key's own server.

## Rotated date

keypin keeps a `rotated` entry in the secret's metadata, with the day the value last changed as `YYYY-MM-DD`.
`keypin rotate` sets it to today and keeps the secret's other metadata. secretspec doesn't read it.

## Permissions

Add the identity to each project keypin reads, with read access to its environments. `keypin rotate` also needs
write access.

## Signing in from GitHub Actions

A job, such as [scheduled rotation](../../guides/scheduled-rotation.md), can sign in with OIDC, with no client secret
stored in the repo:

1. Create a machine identity with [OIDC Auth](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github)
   and add it to the project. Set the discovery URL and issuer to `https://token.actions.githubusercontent.com`, the
   audience to `https://github.com/<owner>`, and the subject to your repo's branch, such as
   `repo:owner@123456/repo@456789:ref:refs/heads/main`, or, for a job with an `environment` like scheduled
   rotation's, `repo:owner@123456/repo@456789:environment:rotation`
   ([subject formats](aws-secrets-manager.md#signing-in-from-github-actions)). Set **Access Token TTL** and **Access
   Token Max TTL** to a few minutes; both default to 30 days.
2. Give the job `permissions: id-token: write`, and set `KEYPIN_INFISICAL_IDENTITY_ID` to the identity's ID, with
   the other Infisical variables unset. keypin exchanges GitHub's token for an access token and tries to revoke it
   when it's done.

Set `KEYPIN_INFISICAL_AUDIENCE` if the identity expects another audience. keypin sends GitHub's token only to
Infisical Cloud; for your own server, also set `KEYPIN_INFISICAL_URL` to `https://<host>`, the provider's server.

## Limits

- keypin won't save a rotated key in a secret that references or imports another; point `ref` at the source.
- keypin doesn't create folders, so a secret's folder must exist before keypin first saves to it.
- A self-hosted server must be from September 2025 or later.
