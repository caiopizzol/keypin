# Doppler

keypin reads and rotates keys in [Doppler](https://www.doppler.com) configs. `check`, `status`, `publish` and
`rotate` work.

## Sign in

Set a token on the machine. secretspec reads the same variable:

```sh
export DOPPLER_TOKEN=dp.sa.xxxx
```

- A [service account](https://docs.doppler.com/docs/service-accounts) token reads every config the account has
  access to.
- A [service token](https://docs.doppler.com/docs/service-tokens) reads one config, so it suits a server or CI job
  that uses one profile.
- A personal token works, but Doppler hides restricted secrets from it.

In GitHub Actions, keypin can sign in with OIDC instead; see
[Signing in from GitHub Actions](#signing-in-from-github-actions).

## The provider

```toml
[project]
name = "billing"

[providers]
doppler = "doppler://billing"
doppler_prd = "doppler://billing/prd"

[defaults]
providers = ["doppler"]

[profiles.dev]
STRIPE_KEY = { description = "Stripe" }

[profiles.production]
STRIPE_KEY = { description = "Stripe", providers = ["doppler_prd"] }
SHARED_CA = { description = "CA bundle", ref = { item = "shared/SHARED_CA" } }
```

The provider is `doppler://<project>`, or `doppler://<project>/<config>` to name the config. Without a config, the
profile names it. Project and config names use only lowercase letters, digits, `-` and `_`.

## Addresses

- **Without `ref`:** the secret `<KEY>` in the provider's config, else in the config named after the profile. In the
  example, `STRIPE_KEY` is in `dev` for `dev`, and in `prd` for `production`.
- **With `ref`:** `item` is `<config>/<NAME>`, or `<NAME>` in the same config as without `ref`. `SHARED_CA` is in the
  config `shared`.

A secret name uses uppercase letters, digits and `_`, not starting with a digit. Doppler reserves `DOPPLER_PROJECT`,
`DOPPLER_CONFIG` and `DOPPLER_ENVIRONMENT`.

An issuer's `admin` is a reference in keypin's own syntax, not a provider URI: `doppler://<project>/<config>/<NAME>`.

## Rotated date

Doppler keeps no rotated date on a secret, so `keypin status` can't tell when a Doppler key is due, and
[scheduled rotation](../../guides/scheduled-rotation.md) never rotates one: `keypin rotate --check` fails for a key
with a `rotate_every`. [`rotate_every`](../../reference/secretspec-toml.md#toolkeypin) applies to the key name in
every profile, so set it to `"never"` or remove it wherever it's set, which stops scheduled rotation in every
profile, or keep the key in a vault that keeps dates. Then rotate it by hand. To be reminded, set a
[secret reminder](https://docs.doppler.com/docs/secrets#secret-reminders) in Doppler.

## Permissions

`keypin rotate` needs write access to the config: a service account role that can write it, or a service token made
with read/write access.

## Signing in from GitHub Actions

A job that runs keypin, such as `keypin publish`, can sign in with OIDC, without a stored `DOPPLER_TOKEN`. This needs Doppler's Team or Enterprise plan.

1. On a service account that can read and write the config, add a
   [service account identity](https://docs.doppler.com/docs/service-account-identities). Set the discovery URL to
   `https://token.actions.githubusercontent.com`, the `aud` claim to `https://github.com/<owner>`, and the `sub` claim
   to your repo's branch, such as `repo:owner@123456/repo@456789:ref:refs/heads/main`
   ([subject formats](aws-secrets-manager.md#signing-in-from-github-actions)). Keep the identity's token TTL to a few
   minutes.
2. Give the job `permissions: id-token: write`, set `KEYPIN_DOPPLER_IDENTITY_ID` to the identity's ID, and leave
   `DOPPLER_TOKEN` unset. keypin exchanges GitHub's token for a short-lived Doppler token and tries to revoke it when
   it's done.

Set `KEYPIN_DOPPLER_AUDIENCE` if the identity expects another audience.

## Limits

keypin won't save a rotated key in a secret that references another, such as `${shared.prd.STRIPE_KEY}`, or that a
branch config's root or an inherited config also holds; point `ref` at the source secret.
