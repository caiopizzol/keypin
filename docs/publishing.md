# Publishing

`keypin publish` reads a key from 1Password and writes it to every destination listed for it.

```sh
keypin publish API_TOKEN             # the prod entry
keypin publish API_TOKEN --env dev   # another environment
keypin publish --all                 # every key with destinations, with one approval
keypin publish --all --plan          # show the plan and write nothing
```

It writes GitHub Actions secrets with your `gh` login, and Cloudflare Worker secrets with your `wrangler` login or
`KEYPIN_CLOUDFLARE_API_TOKEN` (see [Notes](notes.md#signing-in-to-cloudflare)). The Worker, and a GitHub
`environment` the map names, must already exist. Writing a Worker secret deploys a new version of the Worker, so
deploy the Worker's latest version first; `--all` writes up to 100 of a Worker's keys in one version. keypin doesn't
publish to Pages projects, Workers for Platforms namespaces, GitHub Enterprise Server or ghe.com. Run `keypin check`
first: it lists what's missing.

It writes Vercel variables as Sensitive with `KEYPIN_VERCEL_TOKEN`, one per `environment`: `production`, `preview`,
`development` or a custom environment's name. Vercel uses a new value only in new deployments, so redeploy after
publishing; keypin doesn't. It stops rather than change a variable that also covers another environment, and
leaves Git branch variables alone.

It writes Netlify variables as secrets with `KEYPIN_NETLIFY_TOKEN`, one value per `context`: `production`,
`deploy-preview`, `branch-deploy` or `dev-server`. Netlify uses a new value only from the next build and deploy, so
redeploy after publishing; keypin doesn't. It stops rather than write to a variable not marked as secret. It leaves
other contexts and branch values alone. For `netlify dev`, run `keypin run -- netlify dev`.

## Steps

1. **Accounts:** it checks that each login reaches the account the map pins, and stops if one doesn't.
2. **Plan:** it reads the value and shows what it will write where. It skips a destination when this machine's
   receipt shows it already got this value; keypin never reads a destination's secret.
3. **Approval:** you answer `y`.
4. **Receipts:** it records each write on this machine, so a rerun skips destinations that are done.

A first write to a destination, a changed account and a changed vault item always need a `y` in a terminal.
`--yes` approves only routine updates. Without a terminal, a publish that needs a `y` stops before reading the
value and prints the command to run in one.

A teammate's machine has no receipts, so their first publish counts as a first write.

## --plan

`--plan` runs the account checks and shows the full plan, then stops, even without a terminal. Use it to see what
you'll approve. It reads the value, so 1Password asks you to approve it, but it never writes or prints a value. It
exits 3 when the plan would write and 0 when there's nothing to write.

## Every key

`--all` publishes every key that has destinations in the environment, with one plan and one approval. If a write
fails, it stops and keeps the receipts so far; run it again to continue.

keypin never deletes a secret from a destination you remove from the map.
