# Rotation

`keypin rotate <VARIABLE>` replaces a Cloudflare account API token with a new one that has the same permissions. It
works in two runs, so you can check that everything still works before the old token is revoked.

## Set up

Add a `rotate` section to the key's environment:

```toml
[keys.CLOUDFLARE_API_TOKEN.prod.rotate]
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

Store it in its own 1Password item, with a `rotated` date like any other key, and point `admin` at it. `rotate`
stops if `admin` names the key's own item, or reads the key's own value. Only `rotate` reads it. keypin never publishes it, and `run` never passes it on.

## First run: replace

```sh
keypin rotate CLOUDFLARE_API_TOKEN
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
keypin rotate CLOUDFLARE_API_TOKEN
```

keypin checks that every destination of the key has the new token, and that the vault item still holds it. If another
key or project published the old token from its own receipt, keypin stops and gives the `keypin publish` command to run
for each one. A destination that no registered map lists any more is only shown. keypin then shows when the old token
was last used, and deletes it after you type `yes` in a terminal. `--yes` never revokes.

keypin knows what a destination holds only from its receipts. It can't see a secret you set by hand, or a write whose
run stopped before its receipt was saved.

## See the plan first

Add `--plan` to see what the next run would do, without a terminal. It does that run's reads and checks, prints
its plan, and stops before its first change. It never creates or deletes a token, writes to the vault or a
destination, or saves keypin's state. Every run changes at least the rotation's record, so `--plan` exits 3 with
the command to run, or 1 when a check fails.

- First run: it reads the current value and the admin token and checks every account, then shows both tokens,
  the permissions it copies, the vault item, every destination, and whether `--yes` could approve it.
- After a run that stored the new token: it reads both values and checks every account and the new token, then
  shows what it would write where.
- Revoke run: it runs the revoke's checks, then shows the old token's last-used time and the new token. The last-used time shows
  whether something still uses the old token. It doesn't prove the new one works, so check the consumers too.
- After a run that stopped before storing: the token the next run would delete. It reads at most the current
  value, to see which token the item holds, and checks no account or token.
- If the old token is already gone: the next run records the rotation as finished, and asks nothing.

1Password asks you to approve `--plan`, because it reads values. Without `--plan`, a run that has no terminal
stops before reading anything, so `--plan` costs one more 1Password approval in exchange for a plan you can check
first.

If a run stops partway, `keypin status` shows the unfinished rotation, and the next run in that project picks it up.
If keypin can't tell whether Cloudflare made the new token, it names the token for you to find and delete in the
dashboard.
