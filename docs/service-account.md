# Service account

On a server or in CI without the 1Password desktop app, keypin can sign in with a
[1Password service account](https://developer.1password.com/docs/service-accounts/). It only reads: `run`, `check`,
`status` and `publish` work; `import` needs the desktop app.

1. Move the items into a vault you create. Service accounts can't open the built-in Private, Personal or Employee
   vaults. Update each reference in `keypin.toml`.
2. Create the service account with read access to that vault.
3. Pin the account by its sign-in address, such as `acme.1password.com`, or its account ID.
4. Set both variables on the machine:

   ```sh
   export KEYPIN_1PASSWORD=service-account
   export OP_SERVICE_ACCOUNT_TOKEN=...
   ```

Without `KEYPIN_1PASSWORD=service-account`, keypin uses the desktop app even when the token is set. keypin never
passes either variable to the command `keypin run` starts.

Before it reads, keypin checks the token's sign-in address against a pinned address and refuses another account. A
token has no account ID, so keypin can't check an ID pin, and every individual account signs in at
`my.1password.com`, so it can't prove that one either. In both cases, the vaults you granted the service account
are what limit it.

1Password limits each token to a number of reads an hour (1,000 on Families and Teams).
