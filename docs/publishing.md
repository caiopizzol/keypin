# Publishing

`keypin publish` reads a key from 1Password and writes it to every destination listed for it.

```sh
keypin publish API_TOKEN             # the prod entry
keypin publish API_TOKEN --env dev   # another environment
keypin publish --all                 # every key with destinations, with one approval
keypin publish --all --plan          # show the plan and write nothing
```

It writes GitHub Actions secrets with your `gh` login and Cloudflare Worker secrets with your `wrangler` login. The
Worker must already exist. Run `keypin check` first: it checks each login and lists what's missing.

## Steps

1. **Accounts:** it checks that each login reaches the account the map pins, and stops if one doesn't.
2. **Plan:** it reads the value and shows what it will write where. A destination that already has this value is
   skipped.
3. **Approval:** you type `yes`.
4. **Receipts:** it records each write on this machine, so a rerun skips destinations that are done.

A first write to a destination, a changed account and a changed vault item always need a typed `yes` in a terminal.
`--yes` approves only routine updates. Without a terminal, `publish` stops before reading the value and prints the
command to run in one.

A teammate's machine has no receipts, so their first publish counts as a first write.

## --plan

`--plan` runs the account checks and shows the full plan, then stops, even without a terminal. Use it to see what
you'll approve. It reads the value, so 1Password asks you to approve it, but it never writes or prints a value. It
exits 3 when the plan would write and 0 when there's nothing to write.

## Every key

`--all` publishes every key that has destinations in the environment. It checks every account first, shows one plan
and asks for one `yes`. If a write fails, it stops and keeps the receipts so far; run it again to continue.

keypin never deletes a secret from a destination you remove from the map.
