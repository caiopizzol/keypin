# Bitwarden

keypin can read keys from [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/) instead of
1Password. `run`, `check`, `status`, `publish` and `rotate` work; `import` creates 1Password items, so add the
secrets in Bitwarden yourself.

1. Create a [machine account](https://bitwarden.com/help/machine-accounts/) and give it Can read on each project
   keypin reads. `keypin rotate` needs Can read, write, to save the new key.
2. Pin your organization in `keypin.toml`, and reference each secret by project and name:

   ```toml
   [bitwarden]
   organization = "2f1d6c9e-8a3b-4c5d-9e7f-0a1b2c3d4e5f"
   url = "https://vault.bitwarden.eu"
   
   [keys.STRIPE_KEY]
   rotate_every = "90d"
   dev = "bitwarden://billing-dev/STRIPE_KEY"
   prod = "bitwarden://billing/STRIPE_KEY"
   ```

   `organization` is the ID in the address bar when you open Secrets Manager. Leave out `url` for the US cloud; set
   it for the EU cloud or a self-hosted server. `billing` is the project's name, or its ID if two projects share the
   name. keypin refuses a name that two secrets in the project share.

3. Set the machine account's [access token](https://bitwarden.com/help/access-tokens/) on the machine:

   ```sh
   export BWS_ACCESS_TOKEN=...
   ```

keypin never passes `BWS_ACCESS_TOKEN` to the command `keypin run` starts. Before it reads, keypin checks that the
machine account belongs to the pinned organization and refuses another.

For `keypin status`, add a line `rotated: YYYY-MM-DD` to each secret's note, with the day the value last changed.
`keypin rotate` updates that line and keeps the rest of the note.
