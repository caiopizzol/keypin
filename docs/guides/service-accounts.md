# Service accounts

On a server or in CI without the 1Password desktop app, keypin can sign in with a
[1Password service account](https://developer.1password.com/docs/service-accounts/). With read access, `check`,
`status` and `publish` work. `rotate` saves to 1Password, so it also needs write access.

1. Move the items into a vault you create. Service accounts can't open the built-in Private, Personal or Employee
   vaults, or the default Shared vault. Point `[providers]` in `secretspec.toml` at it, and each issuer's `admin`.
2. Create the service account with read access to that vault, and write access if it rotates. 1Password can't
   change a service account's access later; you'd create a new one.
3. Set both variables on the machine:

   ```sh
   export KEYPIN_1PASSWORD=service-account
   export OP_SERVICE_ACCOUNT_TOKEN=...
   ```

Without `KEYPIN_1PASSWORD=service-account`, keypin uses the desktop app even when the token is set. secretspec reads
`OP_SERVICE_ACCOUNT_TOKEN` too, so the same token lets a CI job run `secretspec run`.

When the provider names an account by its sign-in address, such as `onepassword://acme.1password.com@Billing`,
keypin checks the token's sign-in address against it before it reads, and refuses another account. A token has no
account name or ID, so keypin can't check an account written as a name or ID. Individual accounts share
`my.1password.com`, `my.1password.ca` and `my.1password.eu`, so keypin can't prove those either. In these cases, and
without an account in the provider, the vaults you granted the service account are what limit it.

1Password limits each token to 1,000 reads and 100 writes an hour on individual, Families and Teams accounts (10,000
and 1,000 on Business), and all service accounts together to 1,000 requests a day (5,000 on Teams, 50,000 on
Business). See [rate limits](https://www.1password.dev/service-accounts/rate-limits).
