# Rotation

`keypin rotate <key-id>` replaces a Cloudflare account API token with a new one that has the same permissions. It
works in two runs, so you can check that everything still works before the old token is revoked.

## Set up

Add an `issue` section to the key's environment:

```toml
[keys.site-deploy.prod.issue]
provider = "cloudflare-account-token"
account = "<Cloudflare account ID>"
admin = "op://Private/shared cloudflare token admin/credential"
```

The key also needs at least one destination and a `rotate_every` other than `never`.

### The admin token

`rotate` creates and deletes tokens with an admin token. In the Cloudflare dashboard, go to **Manage account** →
**Account API tokens** → **Create Token** → **Custom token**, and give it:

- **Account** → **Account API Tokens** → **Edit**, and nothing else;
- the account your keys live in;
- a short expiry, such as 30 days.

Store it in 1Password, with a `rotated` date like any other key, and point `admin` at it. Only `rotate`
reads it. keypin never publishes it, and `run` never passes it on.

## First run: replace

```sh
keypin rotate site-deploy
```

1. keypin finds the current token from its value, so a token made in the dashboard works too.
2. It shows the plan: both tokens, the permissions it copies, the vault item and every destination. You type `yes`,
   or pass `--yes` when no destination needs approval.
3. It creates the new token, named after the old one plus today's date. The new token expires `rotate_every` plus
   14 days from today, so `status` shows it due before it stops working.
4. It checks the new token works and has the same permissions. If not, it deletes the new token and stops. If that
   delete fails, the next run offers to delete it again.
5. It stores the new token in the vault item, with `rotated` set to today, and publishes it.

The old token stays active.

## Second run: revoke

Check that everything using the key works with the new token, for example by running a deploy. Then run the same
command again:

```sh
keypin rotate site-deploy
```

keypin checks that every destination of the key has the new token, and that the vault item still holds it. If another
key or project published the old token from its own receipt, keypin stops and gives the `keypin publish` command to run
for each one. A destination that no registered map lists any more is only shown. keypin then shows when the old token
was last used, and deletes it after you type `yes` in a terminal. `--yes` never revokes.

keypin knows what a destination holds only from its receipts. It can't see a secret you set by hand, or a write whose
run stopped before its receipt was saved.

If a run stops partway, `keypin status` shows the unfinished rotation, and the next run picks it up. If keypin
can't tell whether Cloudflare made the new token, it names the token for you to find and delete in the dashboard.
