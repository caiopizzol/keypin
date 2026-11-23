# Your first project

This page sets up keypin in one project. `keypin init` writes the map, and `keypin check` tells you what the project
uses, what's missing, and what to do next.

## Write the map

In the project's root folder:

```sh
cd /work/billing
keypin init
```

```
ok     wrote /work/billing/keypin.toml
ok     registered (1 project)

Next: keypin check  what this project uses, and the TOML to add
```

`init` writes a `keypin.toml` whose lines are all commented out: a template that shows the fields. You rarely edit
it by hand at first, because `keypin import` and `keypin check` write or print the lines for you. If the file exists,
`init` leaves it as it is.

It also registers the project in `~/.config/keypin/registry.json`, so `keypin status` lists it.

## Check the project

```sh
keypin check
```

`check` reads the project's env files, wrangler configs and GitHub Actions workflows. It looks up each mapped item
in your vault, not its value, checks that each login reaches the account the map pins, and asks each destination
which secrets it has, by name. It writes nothing and prints no value.

Here it is in a project with a `.env` that sets `DATABASE_URL` and `RESEND_API_KEY`, a workflow that uses the GitHub
secret `STRIPE_API_KEY`, and a wrangler config that requires `RESEND_API_KEY`:

```
billing /work/billing · read 2 env files, 1 wrangler config, 1 workflow; GitHub acme/billing
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
  If you ran the import above, run keypin check again for this TOML instead; the import wrote some of these tables.
  Replace each <...> with the real value; keypin rejects a map that still has one:

[1password]
account = "<1Password sign-in address>"

[keys.STRIPE_API_KEY]
rotate_every = "90d"

[keys.STRIPE_API_KEY.prod]
from = "op://<vault>/<item>/<field>"

[[keys.STRIPE_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"

[keys.RESEND_API_KEY]
rotate_every = "90d"

[keys.RESEND_API_KEY.prod]
from = "op://<vault>/<item>/<field>"

[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"
account = "11111111111111111111111111111111"
worker = "billing-worker"

  Then run keypin check again.
```

## Reading check's output

- **The first line** names the project and what `check` read. A folder that is its own git repository isn't scanned,
  and `check` lists it.
- **The numbered steps** are in the order to do them. Logins and apps come first, because later steps need them.
  Each step says why it's there, and gives the command to run, indented, or the TOML to add.
- **The TOML** is what to paste into `keypin.toml`. Replace each `<...>`, such as the vault reference: in 1Password,
  open the field's menu and select **Copy Secret Reference**.
- **`Not checked:`** lines name what `check` couldn't read, and why. That is unverified, not missing.
- **`Note:`** lines are worth reading, but they aren't things to do.

Run `keypin check` again after each change. When nothing is left, it says so and exits 0:

```
ok     Looked up 4 items in 1Password account my.1password.com, not the values
ok     Checked 2 accounts
billing /work/billing · read 1 env file, 1 wrangler config, 1 workflow; GitHub acme/billing
ok     3 keys, 2 destinations. Everything checks out.
```

It exits 1 while there's something to do. `keypin check --json` prints the same report as JSON, for scripts and
agents.

Next: [Run your app locally](run-your-app-locally.md), which does step 3 and runs your app with the keys.
