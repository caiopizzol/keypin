# Configuration

Each project has a `keypin.toml` at its root. It holds names and places, never values. keypin rejects any field it
doesn't know, so a typo shows up as an error.

A value in angle brackets, such as `<Cloudflare account ID>` or `op://<your vault>/...`, is a placeholder for you
to fill in. keypin rejects one in the 1Password `account`, any part of an `op://` reference, a `repo`, or a
Cloudflare `account` or `worker`, and says what to put there.

A `keypin.toml` from keypin 0.4 (with `[vaults]`, `env`, `vault` and `item`) doesn't parse any more. Rewrite it in
the format below. A keypin 0.6 `account` on a `github-actions`
destination is gone: delete it (see [Who publishes](#who-publishes)). Shared `[targets]` from keypin 0.6 are gone
too: write each destination inline under `[[keys.<VARIABLE>.<env>.publish]]`, and delete `[targets]`. A `rotate`
section (or a keypin 0.5 `issue` section) is gone with `keypin rotate`: delete it, and rotate the key by hand (see
[Vault items](#vault-items)).

## 1Password account

```toml
[1password]
account = "my.1password.com" # its sign-in address, as at the top left of the 1Password app, or its account ID
```

Commit it. A team shares one account, such as a 1Password Teams or Business account, and every member signs in to
it.

## Keys

```toml
[keys.API_TOKEN] # the variable your program reads
rotate_every = "180d" # <n>d, <n>w, <n>m or never
```

A key needs at least one environment. By default these are `dev` and `prod`. Each one names the value with a
1Password secret reference, `op://<vault>/<item>/<field>`, or `op://<vault>/<item>/<section>/<field>` when two
fields share a name. Copy it from 1Password: open the item, select the field's menu, then **Copy Secret Reference**.

```toml
dev = "op://Private/my-project dev api token/credential" # what keypin run reads

[keys.API_TOKEN.prod] # what keypin publish reads by default
from = "op://Private/my-project prod api token/credential"
```

Use the short form, `dev = "op://..."`, when the environment has nothing else. Use a table with `from` when it
also has destinations.

## Environments

To use other names, list them at the top of the file. The first is what `keypin run` reads by default, and the last
is what `publish` uses by default. `--env <name>` picks another.

```toml
environments = ["dev", "staging", "prod"]
```

Every name a key uses must be listed, so a typo such as `stagng` is an error. A name starts with a lowercase letter
and uses only lowercase letters, digits and dashes.

## Destinations

Under an environment, list every place `publish` writes the key. `keypin check` prints these tables for each
secret a workflow or Worker needs that the map doesn't publish there, with the repo, Worker and account filled in
when it knows them, and `<...>` where it doesn't. Replace each `<...>` before you run another command; keypin
rejects a map that still has one.

```toml
[[keys.API_TOKEN.prod.publish]]
to = "github-actions"
repo = "owner/repo" # its owner is the account keypin checks

[[keys.API_TOKEN.prod.publish]]
to = "cloudflare-worker"
account = "<Cloudflare account ID>" # 32 hex characters
worker = "my-worker"
```

GitHub reserves secret names that start with `GITHUB_`, so a key with such a name can't publish to GitHub Actions.

### Who publishes

The map pins where a key goes, not who writes it, so every teammate can publish from the same map. Each machine
picks its own publisher:

- **GitHub:** the login in `git config github.account` when it's set (`git config github.account alice`), or else
  the active `gh` login. The account check passes when the repo's owner is the one in `repo` and that login has
  write access to the repo. For an organization's repo, that's anyone with the Write, Maintain or Admin role.
- **Cloudflare:** the `wrangler` login. The account check passes when it reaches the pinned `account`.

Receipts record both the pinned account and the login that wrote. `keypin check` shows, for each destination, the
login this machine would use, who it acts as, and the account it reaches.

## Vault items

The reference's field holds the value. Any field works, such as `password` or an API Credential item's
`credential`, except `rotated`. Add a **`rotated`** Date field, the day the value last changed.

`keypin status` adds the key's `rotate_every` to `rotated` to show when it's due. Without a `rotate_every`, `status`
reports the key as a problem. keypin only reminds you; to rotate a key, put the new value in the field, set
`rotated` to today, then run `keypin publish <VARIABLE>`.
