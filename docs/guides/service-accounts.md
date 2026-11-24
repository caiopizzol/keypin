# Service accounts

On a server or in CI without the 1Password desktop app, keypin can sign in with a
[1Password service account](https://developer.1password.com/docs/service-accounts/). With read access, `check`,
`status` and `publish` work. `rotate` saves to 1Password, so it also needs write access.

1. Move the items into a vault for this project alone: a service account reaches every item in its vaults. Service
   accounts can't open the built-in Private, Personal or Employee vaults, or the default Shared vault. Point
   `[providers]` in `secretspec.toml` at it, and each issuer's `admin`.
2. Create the service account with read access to that vault, and write access if it rotates. 1Password can't
   change a service account's access later; you'd create a new one. For a command that saves its token without
   printing it, see [Scheduled rotation](scheduled-rotation.md#setup).
3. Set both variables on the machine:

   ```sh
   export KEYPIN_1PASSWORD=service-account
   export OP_SERVICE_ACCOUNT_TOKEN=...
   ```

Without `KEYPIN_1PASSWORD=service-account`, keypin uses the desktop app even when the token is set. secretspec reads
`OP_SERVICE_ACCOUNT_TOKEN` too, so the same token lets a CI job run `secretspec run`.

When the provider names an account by its sign-in address, such as `onepassword://acme.1password.com@Billing`,
keypin checks the token against it before it reads. It can't check an account written as a name or ID, or an
individual account on `my.1password.com`, `my.1password.ca` or `my.1password.eu`. There, and without an account in
the provider, only the vaults you granted the service account limit it.

1Password limits each token to 1,000 reads and 100 writes an hour on individual, Families and Teams accounts (10,000
and 1,000 on Business), and all service accounts together to 1,000 requests a day (5,000 on Teams, 50,000 on
Business). See [rate limits](https://www.1password.dev/service-accounts/rate-limits).

## Expiry

1Password can't tell keypin when a service account expires, so set a reminder to replace it before the date you gave
`--expires-in`.
