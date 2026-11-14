# Service account

On a server or in CI without the 1Password desktop app, keypin can sign in with a
[1Password service account](https://developer.1password.com/docs/service-accounts/). It only reads: `run`, `check`,
`status` and `publish` work; `import` needs the desktop app.

1. Move the items into a vault you create. Service accounts can't open the built-in Private, Personal or Employee
   vaults. Update each reference in `keypin.toml`.
2. Create the service account with read access to that vault.
3. Pin the account by its sign-in address, such as `acme.1password.com`, not its ID.
4. Set both variables on the machine:

   ```sh
   export KEYPIN_1PASSWORD=service-account
   export OP_SERVICE_ACCOUNT_TOKEN=...
   ```

Without `KEYPIN_1PASSWORD=service-account`, keypin uses the desktop app even when the token is set. keypin never
passes either variable to the command `keypin run` starts.

keypin checks the token's sign-in address against the pinned account before it reads. Every individual account
signs in at `my.1password.com`, so there keypin can't prove it's the same account; the vaults you granted the
service account are what limit it.

1Password limits each token to a number of reads an hour (1,000 on Families and Teams).
