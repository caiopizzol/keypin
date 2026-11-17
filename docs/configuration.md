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

[[keys.API_TOKEN.prod.publish]]
to = "supabase-functions"
project_ref = "<20-letter project ref>"

[[keys.API_TOKEN.prod.publish]]
to = "netlify-project"
team = "<team slug>"
project = "my-project.netlify.app"
context = "production"
```

GitHub reserves secret names that start with `GITHUB_`. Add `environment = "production"` to write a secret of that
GitHub environment instead of a repo secret; the environment must already exist. The two are separate destinations.

The map says where a key goes, not who writes it, so every teammate publishes from the same map:

- **GitHub:** the login in `git config github.account`, or else the active `gh` login. It needs write access to the
  repo.
- **Cloudflare:** the `wrangler` login, or `KEYPIN_CLOUDFLARE_API_TOKEN`. It must reach the pinned `account`.
- **Vercel:** a token in `KEYPIN_VERCEL_TOKEN`, for the `team` or the project. keypin doesn't read the `vercel`
  login or `VERCEL_TOKEN`.
- **Supabase:** a personal access token in `KEYPIN_SUPABASE_ACCESS_TOKEN` with Edge Function Secrets Read-write on
  the project. keypin doesn't read the `supabase` login or `SUPABASE_ACCESS_TOKEN`.
- **Netlify:** a personal access token in `KEYPIN_NETLIFY_TOKEN`, from a member of the `team`. keypin doesn't read
  the `netlify` login or `NETLIFY_AUTH_TOKEN`.

## Vault items

Any field except `rotated` can hold the value, such as `password` or an API Credential's `credential`. Add a
**`rotated`** Date field with the day the value last changed; `keypin status` adds `rotate_every` to it to show when
the key is due.

## Rotating a key

Add an `issuer` table to let `keypin rotate <VARIABLE>` make the new key, at Resend, [Neon](#neon),
[OpenAI](#openai), [Supabase](#supabase), [Cloudflare](#cloudflare), [OpenRouter](#openrouter) or
[Google Cloud](#google-cloud):

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

### Cloudflare

```toml
[keys.CLOUDFLARE_API_TOKEN.prod]
from = "op://Private/deploy cloudflare token/credential"

[keys.CLOUDFLARE_API_TOKEN.prod.issuer]
kind = "cloudflare"
admin = "op://Private/cloudflare token maker/credential"
```

`admin` is a token made with the
[Create additional tokens](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/) template, in
its own 1Password item. For an account API token (`cfat_`), add `account_id` and use an admin token with
**Account API Tokens** Edit on that account.

keypin finds the vault's token with Cloudflare's verify endpoint, makes a new token with the same policies, IP
filter and lifetime (and its start date, if still ahead), then deletes the old one. It doesn't use Roll, which stops the old token at once.

### OpenRouter

```toml
[keys.OPENROUTER_API_KEY.prod]
from = "op://Private/app openrouter key/credential"

[keys.OPENROUTER_API_KEY.prod.issuer]
kind = "openrouter"
admin = "op://Private/openrouter management key/credential"
```

`admin` is a read/write [management key](https://openrouter.ai/settings/management-keys), in its own 1Password item,
for the organization or the key's workspace. keypin finds the vault's key by the label OpenRouter shows for it, and
gives the new key the same credit limit, reset, BYOK setting, lifetime and workspace. A limit that never resets starts
again at $0 spent on the new key; the old key keeps its credit until you revoke it. keypin refuses a disabled key, and
a key with its own guardrail, or a BYOK provider key or observability destination limited to it, since the new
key wouldn't get them.

### Google Cloud

For Google API keys such as `GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY` or `YOUTUBE_API_KEY`:

```toml
[keys.GOOGLE_MAPS_API_KEY.prod]
from = "op://Private/maps api key/credential"

[keys.GOOGLE_MAPS_API_KEY.prod.issuer]
kind = "google"
admin = "op://Private/google key maker/credential"
```

`admin` is a service account's [JSON key](https://cloud.google.com/iam/docs/keys-create-delete), the whole file, in
its own 1Password item. Give the service account **API Keys Admin** (`roles/serviceusage.apiKeysAdmin`) on the
key's project, and turn on the API Keys API in the service account's project. keypin doesn't use gcloud logins.

keypin finds the vault's key from its value, makes a key in the same project with the same name, API restrictions
and application restrictions (websites, IP addresses, Android or iOS apps), then deletes the old one. A key with no
restrictions gets a key with none. Google Cloud keeps a deleted key for 30 days, so you can restore it.
