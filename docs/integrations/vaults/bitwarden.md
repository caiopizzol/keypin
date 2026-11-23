# Bitwarden

keypin reads and rotates keys in [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/)
projects. `check`, `status`, `publish` and `rotate` work. keypin doesn't create secrets: save each value with
`secretspec set` first.

## Sign in

Create a [machine account](https://bitwarden.com/help/machine-accounts/), and set its
[access token](https://bitwarden.com/help/access-tokens/) on the machine. secretspec reads the same variable:

```sh
export BWS_ACCESS_TOKEN=...
```

## The provider

```toml
[project]
name = "billing"

[providers]
bws_dev = "bws://a1b2c3d4-0000-4000-8000-000000000001"
bws_prod = "bws://vault.bitwarden.eu@a9230ec4-5507-4870-b8b5-b3f500587e4c"

[profiles.default.defaults]
providers = ["bws_dev"]

[profiles.production.defaults]
providers = ["bws_prod"]

[profiles.default]
STRIPE_KEY = { description = "Stripe" }

[profiles.production]
DATABASE_URL = { description = "Database", ref = { item = "prod-db-connection" } }
```

The provider is `bws://<project ID>`, with the ID from the project's page in Secrets Manager. For the EU cloud or
your own server, put its host before the ID, as `bws://vault.bitwarden.eu@<project ID>`. Without it, keypin uses
`vault.bitwarden.com`.

`bw://` is Bitwarden's Password Manager, which keypin doesn't read, so keypin refuses it. keypin also refuses a URI
that names more than a project.

## Addresses

- **Without `ref`:** the secret named `<KEY>` in the project. The profile isn't part of the name, so every profile on
  one provider reads the same secret: give each profile its own provider, as above.
- **With `ref`:** `item` is the secret's name. keypin refuses `field`, `section`, `vault` and `version`.

keypin refuses a name that two secrets in the project share.

An issuer's `admin` is a reference in keypin's own syntax, `bitwarden://<project>/<NAME>`, with the project's name,
or its ID if two projects share the name. keypin reads it from the key's own server.

## Rotated date

keypin keeps a line `rotated: YYYY-MM-DD` in the secret's note, with the day the value last changed.
`keypin rotate` updates that line and keeps the rest of the note. secretspec doesn't read it.

## Permissions

Give the machine account Can read on each project keypin reads. `keypin rotate` needs Can read, write.
