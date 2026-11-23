# Bitwarden

keypin reads secrets from [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/) projects.
`run`, `check`, `status`, `publish` and `rotate` work. keypin doesn't create Bitwarden secrets, so add them in
Bitwarden yourself; `import` creates 1Password items.

## Sign in

Create a [machine account](https://bitwarden.com/help/machine-accounts/), and set its
[access token](https://bitwarden.com/help/access-tokens/) on the machine:

```sh
export BWS_ACCESS_TOKEN=...
```

keypin checks that the machine account belongs to the pinned organization, and never passes `BWS_ACCESS_TOKEN` to
the command `keypin run` starts.

## The map

```toml
[bitwarden]
organization = "2f1d6c9e-8a3b-4c5d-9e7f-0a1b2c3d4e5f"
url = "https://vault.bitwarden.eu"

[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "bitwarden://billing-dev/STRIPE_KEY"
```

| Field          | Value                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- |
| `organization` | The ID in the address bar when you open Secrets Manager. Required.                            |
| `url`          | Leave it out for the US cloud. Set it for the EU cloud or a self-hosted server, with no path. |

## References

A reference is `bitwarden://<project>/<SECRET_NAME>`, such as `bitwarden://billing/STRIPE_KEY`. Use the project's
name, or its ID if two projects share the name. keypin refuses a name that two secrets in the project share.

## Rotated date

Add a line `rotated: YYYY-MM-DD` to the secret's note, with the day the value last changed. `keypin rotate` updates
that line and keeps the rest of the note.

## Permissions

Give the machine account Can read on each project keypin reads. `keypin rotate` needs Can read, write.
