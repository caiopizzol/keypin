# Service account

On a server or in CI without the 1Password desktop app, keypin can sign in with a
[1Password service account](https://developer.1password.com/docs/service-accounts/). With read access, `run`, `check`,
`status` and `publish` work. `rotate` and `import` save to 1Password, so they also need write access.

1. Move the items into a vault you create. Service accounts can't open the built-in Private, Personal or Employee
   vaults, or the default Shared vault. Update each reference in `keypin.toml`.
2. Create the service account with read access to that vault, and write access if it rotates or imports. 1Password
   can't change a service account's access later; you'd create a new one.
3. Pin the account by its sign-in address, such as `acme.1password.com`, or its account ID.
4. Set both variables on the machine:

   ```sh
   export KEYPIN_1PASSWORD=service-account
   export OP_SERVICE_ACCOUNT_TOKEN=...
   ```

Without `KEYPIN_1PASSWORD=service-account`, keypin uses the desktop app even when the token is set. keypin never
passes either variable to the command `keypin run` starts.

Before it reads, keypin checks the token's sign-in address against a pinned address and refuses another account. A
token has no account ID, so keypin can't check an ID pin. Individual accounts share `my.1password.com`,
`my.1password.ca` and `my.1password.eu`, so keypin can't prove those either. In both cases, the vaults you granted
the service account are what limit it.

1Password limits each token to 1,000 reads and 100 writes an hour on individual, Families and Teams accounts (10,000
and 1,000 on Business), and all service accounts together to 1,000 requests a day (5,000 on Teams, 50,000 on
Business). See [rate limits](https://www.1password.dev/service-accounts/rate-limits).
