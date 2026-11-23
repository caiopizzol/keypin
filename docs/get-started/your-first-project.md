# Your first project

`keypin init` writes the map. `keypin check` reports what the project uses and what to do next.

## Write the map

In the project's root folder:

```sh
keypin init
```

It writes a `keypin.toml` template, all commented out, and registers the project for `keypin status`. You rarely
edit the map by hand: `import` writes it, and `check` prints the lines to add.

## Check the project

```sh
keypin check
```

`check` reads env files, wrangler configs and GitHub Actions workflows. It looks up each mapped item in your vault,
not its value, and the secret names at each destination. It writes nothing.

In this project, `.env` sets `DATABASE_URL` and `RESEND_API_KEY`, a workflow uses the GitHub secret
`STRIPE_API_KEY`, and the Worker requires `RESEND_API_KEY`:

```
billing /work/billing · read 1 env file, 1 wrangler config, 1 workflow; GitHub acme/billing
4 things to do, in this order:
1 Sign in to Cloudflare
    wrangler login
  Or set KEYPIN_CLOUDFLARE_API_TOKEN to a Cloudflare API token.
2 Set up 1Password
  keypin needs the 1Password desktop app, with Settings → Developer → Integrate with other apps selected.
3 Move .env's keys into 1Password
  .env sets DATABASE_URL, RESEND_API_KEY, which keypin.toml doesn't map.
    keypin import .env DATABASE_URL RESEND_API_KEY --vault <vault> --account <1Password sign-in address>
  Leave out a name that isn't a key; it stays in the file.
4 Add the production keys to keypin.toml
  STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing doesn't have it, and keypin.toml doesn't publish it there.
  RESEND_API_KEY: wrangler.toml requires it; the Worker billing-worker doesn't have it, and keypin.toml doesn't publish it there.
```

Do the steps in order. Each gives the command to run or the TOML to add. Step 4 also prints TOML, which
[Ship to production](ship-to-production.md) uses after the import.

A `Not checked:` line means `check` couldn't read something: it's unverified, not missing. Run `keypin check` again
after each change; it exits 0 when everything checks out. `--json` prints the report for scripts and agents.

[Run your app locally](run-your-app-locally.md) does step 3.
