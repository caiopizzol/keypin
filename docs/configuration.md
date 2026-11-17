# Configuration

Each project has a `keypin.toml` at its root. It holds names and places, never values. keypin rejects a field it
doesn't know, and a `<...>` placeholder left in a value.

```toml
[1password]
account = "my.1password.com"

[keys.API_TOKEN]
rotate_every = "90d"
dev = "op://Private/my-project dev api token/credential"

[keys.API_TOKEN.prod]
from = "op://Private/my-project prod api token/credential"

[[keys.API_TOKEN.prod.publish]]
to = "github-actions"
repo = "me/my-project"
```

## 1Password account

`account` is the account's sign-in address, such as `my.1password.com`, its name as shown at the top left of the
1Password app, or its account ID. A team shares one account, and each member signs in to it. For Infisical, see
[Infisical](infisical.md).

## Keys

Each `[keys.NAME]` table is named after the variable your program reads.

- `rotate_every`: how often to rotate the key, as `<n>d`, `<n>w`, `<n>m` or `never`. `keypin status` uses it to
  show when the key is due.
- One entry per environment, `dev` and `prod` by default. Each names a 1Password secret reference:
  `op://<vault>/<item>/<field>`, or `op://<vault>/<item>/<section>/<field>` when two fields share a name. In
  1Password, open the field's menu and select **Copy Secret Reference**. keypin reads a field's value, or the item's
  notes as `notesPlain`; not one-time passwords, files or empty values.

Write an environment as `dev = "op://..."`, or as a `[keys.NAME.prod]` table with `from` when it also has
destinations.

## Environments

To use other names, list them at the top of the file:

```toml
environments = ["dev", "staging", "prod"]
```

`keypin run` uses the first by default and `keypin publish` the last; `--env <name>` picks another. A name starts
with a lowercase letter and uses lowercase letters, digits and dashes.

## Ignored keys

List the keys a workflow or env file names that keypin shouldn't manage, such as the optional keys of a copied
workflow. `keypin check` leaves them out, in any case, and says how many it ignores.

```toml
ignore = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
```

## Destinations

List each place `publish` writes the key under its environment. `keypin check` prints these for each secret a
workflow or Worker needs, with the Worker of a wrangler `[env.staging]` under the environment `staging`. It skips,
with a note, an env with `routes = []`, `workers_dev = false`, and no preview URL, trigger, Durable Object, email
address, or binding from another Worker, since only `wrangler dev` runs it.

```toml
[[keys.API_TOKEN.prod.publish]]
to = "github-actions"
repo = "owner/repo"

[[keys.API_TOKEN.prod.publish]]
to = "cloudflare-worker"
account = "<Cloudflare account ID>"
worker = "my-worker"

[[keys.API_TOKEN.prod.publish]]
to = "vercel-project"
team = "<team ID or slug>"
project = "my-project"
environment = "production"
```

GitHub reserves secret names that start with `GITHUB_`. Add `environment = "production"` to write a secret of that
GitHub environment instead of a repo secret; the environment must already exist. The two are separate destinations.

The map says where a key goes, not who writes it, so every teammate publishes from the same map:

- **GitHub:** the login in `git config github.account`, or else the active `gh` login. It needs write access to the
  repo.
- **Cloudflare:** the `wrangler` login, or `KEYPIN_CLOUDFLARE_API_TOKEN`. It must reach the pinned `account`.
- **Vercel:** a token in `KEYPIN_VERCEL_TOKEN`, for the `team` or the project. keypin doesn't read the `vercel`
  login or `VERCEL_TOKEN`.

## Vault items

Any field except `rotated` can hold the value, such as `password` or an API Credential's `credential`. Add a
**`rotated`** Date field with the day the value last changed; `keypin status` adds `rotate_every` to it to show when
the key is due.

## Rotating a key

Add an `issuer` table to let `keypin rotate <VARIABLE>` make the new key, at Resend, [Neon](#neon),
[OpenAI](#openai) or [Supabase](#supabase):

```toml
[keys.RESEND_API_KEY.prod]
from = "op://Private/mailer resend key/credential"

[keys.RESEND_API_KEY.prod.issuer]
kind = "resend"
admin = "op://Private/resend admin key/credential"
permission = "sending_access"
```

- `admin`: a full-access key from the same Resend team, in its own 1Password item, to create and delete keys.
- `permission`: what the new key may do, `full_access` or `sending_access`. Add `domain_id` to limit a sending key
  to one domain.

`rotate` checks every account, shows a plan and asks `y`. It then creates the key, saves it to the `from` reference
with `rotated` set to today, and publishes it like `keypin publish`. It asks a second `y` before it deletes the old
key, and only if every destination got the new one. A rerun picks up where a failed or declined run stopped. It
deletes only a key it created itself; it doesn't know the key you made by hand, so delete that one at the provider.
`--plan` runs the checks and shows the plan, then stops like [`publish --plan`](publishing.md#--plan).

Without an issuer, rotate by hand:

1. Make a new value at the provider.
2. Put it in the 1Password field, and set `rotated` to today.
3. Run `keypin publish <VARIABLE>`.
4. Once everything uses the new value, revoke the old one at the provider.

### Neon

After a Neon password reset, the old password stops working on the next connection, so keypin switches `DATABASE_URL` between two login roles
instead. Create them once with SQL, members of one group role so they keep the same grants:

```sql
CREATE ROLE app NOLOGIN;  -- grant the app's privileges to this role
CREATE ROLE app_a WITH LOGIN IN ROLE app PASSWORD '<password>';
CREATE ROLE app_b WITH LOGIN IN ROLE app PASSWORD '<password>';
```

```toml
[keys.DATABASE_URL.prod]
from = "op://Private/app database url/password"

[keys.DATABASE_URL.prod.issuer]
kind = "neon"
admin = "op://Private/neon api key/credential"
project_id = "quiet-lake-12345678"
branch_id = "br-main-a1b2c3d4"
database = "appdb"
roles = ["app_a", "app_b"]
```

`admin` is a [Neon API key](https://neon.com/docs/manage/api-keys) with Editor or Admin access to the project.
`rotate` resets the password of the role the vault's URL doesn't use and saves your URL with that role. Revoking resets the old role's
password, so every connection string with that role stops working, not only this key. keypin refuses a map where two
keys' issuers share a role, such as a pooled and a direct URL; give the direct URL its own two roles. Each reset drops
every open connection to the compute, whatever its role, so apps must reconnect. A table belongs to the role that
creates it, so run migrations after `SET ROLE app`.

### OpenAI

keypin makes the new key for the service account that owns the vault's key, in the same project, then deletes the old
key. OpenAI's Admin API can't make a key for a user, so keypin refuses a user-owned key: replace it once with a
service-account key from the project's API keys page.

```toml
[keys.OPENAI_API_KEY.prod]
from = "op://Private/app openai key/credential"

[keys.OPENAI_API_KEY.prod.issuer]
kind = "openai"
admin = "op://Private/openai admin key/credential"
project_id = "proj_abc123"
scopes = []
```

- `admin`: an [Admin key](https://platform.openai.com/settings/organization/admin-keys) with write access to projects.
- `scopes`: the new key's scopes, such as `["api.responses.write"]`, or `[]` for all permissions. OpenAI doesn't
  show a key's scopes, so keypin can't copy them; set this to match the old key.

If the old key expires, the new one gets the same lifetime.

### Supabase

```toml
[keys.SUPABASE_SECRET_KEY.prod]
from = "op://Private/app supabase key/credential"

[keys.SUPABASE_SECRET_KEY.prod.issuer]
kind = "supabase"
admin = "op://Private/supabase token/credential"
project_ref = "abcdefghijklmnopqrst"
```

`admin` is a [personal access token](https://supabase.com/dashboard/account/tokens). A scoped token needs **API Keys**
Read-write and **API Key Secrets** Read on the project. `project_ref` is the 20 letters in the project's dashboard URL.

keypin won't rotate the secret key named `default`: Edge Functions that use `withSupabase({ auth: 'secret' })` accept
only that key, and a deleted key can't come back. Give each app its own named key, and rotate that. Each new key
gets a new name, so a function that checks `auth: 'secret:<name>'` rejects it. keypin also refuses a legacy
`service_role` key; move to a secret key with
[Supabase's guide](https://supabase.com/docs/guides/security/rotate-leaked-api-keys).
