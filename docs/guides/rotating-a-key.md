# Rotating a key

`keypin rotate <VARIABLE>` makes a new key at the provider and publishes it to the key's destinations.

Add an `issuer` to the key's `[tool.keypin.<profile>.<KEY>]` table so keypin can make the new key, at Resend,
[Neon](#neon), [OpenAI](#openai), [Supabase](#supabase), [Cloudflare](#cloudflare), [OpenRouter](#openrouter),
[Google Cloud](#google-cloud) (API keys and [service account keys](#google-cloud-service-account-keys)),
[ElevenLabs](#elevenlabs), [AWS](#aws), [SendGrid](#sendgrid), [Twilio](#twilio), [xAI](#xai) or
[MongoDB Atlas](#mongodb-atlas), or make it yourself with [`random`](#random):

```toml
[profiles.production]
RESEND_API_KEY = { description = "Resend" }

[tool.keypin.production.RESEND_API_KEY.issuer]
kind = "resend"
admin = "op://Acme/resend admin key/credential"
permission = "sending_access"
```

- `admin`: a full-access key from the same Resend team, in its own vault item. It's a reference to one secret in the
  key's vault, not a provider URI; see [keypin's settings](../reference/secretspec-toml.md#toolkeypin).
- `permission`: `full_access` or `sending_access`. Add `domain_id` to limit a sending key to one domain.

`rotate` uses the `production` profile, or the last profile; `--profile <name>` picks another. After you answer `y`
to its plan, it creates the key, saves it to your vault with today's rotated date, and publishes it to its
[destinations](publishing.md#destinations). It revokes the old key after a second `y`, and only if every destination
got the new one. A first Resend rotation leaves the old key: delete it at Resend once nothing uses it. For a key
with no destinations, check what reads it before the old one goes: the plan lists only workflows that run
`secretspec run`, not a call inside a script. `keypin --help` covers `--plan`, `--discard` and rerunning a failed
rotation. To rotate on a schedule, see [Scheduled rotation](scheduled-rotation.md).

Without an issuer, rotate by hand:

1. Make a new value at the provider.
2. Save it with `secretspec set <VARIABLE> --profile production`, and set its rotated date to today. For a `ref`
   secretspec only reads, such as an
   [AWS Secrets Manager `ref`](../integrations/vaults/aws-secrets-manager.md#addresses), change it in the vault,
   keeping a JSON secret's other keys, and set the date as that page says.
3. Run `keypin publish <VARIABLE>`.
4. Once everything uses the new value, revoke the old one at the provider.

## Neon

A Neon password reset stops the old password on the next connection, so keypin switches `DATABASE_URL` between two
login roles. Create them once with SQL, members of one group role so they keep the same grants:

```sql
CREATE ROLE app NOLOGIN;  -- grant the app's privileges to this role
CREATE ROLE app_a WITH LOGIN IN ROLE app PASSWORD '<password>';
CREATE ROLE app_b WITH LOGIN IN ROLE app PASSWORD '<password>';
```

```toml
[profiles.production]
DATABASE_URL = { description = "Postgres connection string" }

[tool.keypin.production.DATABASE_URL.issuer]
kind = "neon"
admin = "op://Acme/neon api key/credential"
project_id = "quiet-lake-12345678"
branch_id = "br-main-a1b2c3d4"
database = "appdb"
roles = ["app_a", "app_b"]
```

`admin` is a [Neon API key](https://neon.com/docs/manage/api-keys) with Editor or Admin access to the project.
Revoking resets the old role's password, so every connection string with that role stops working. A pooled and a
direct URL each need their own two roles. Each reset drops every open connection to the compute, so apps must
reconnect. Run migrations after `SET ROLE app`, so tables belong to the group role.

## OpenAI

OpenAI's Admin API can't make a key for a user, so keypin rotates only a service account's key: replace a user-owned
key once with a service-account key from the project's API keys page.

```toml
[profiles.production]
OPENAI_API_KEY = { description = "OpenAI" }

[tool.keypin.production.OPENAI_API_KEY.issuer]
kind = "openai"
admin = "op://Acme/openai admin key/credential"
project_id = "proj_abc123"
scopes = []
```

- `admin`: an [Admin key](https://platform.openai.com/settings/organization/admin-keys) with write access to projects.
- `scopes`: the new key's scopes, such as `["api.responses.write"]`, or `[]` for all permissions. OpenAI doesn't
  show a key's scopes, so set this to match the old key.

The new key gets the old key's lifetime.

## Supabase

```toml
[profiles.production]
SUPABASE_SECRET_KEY = { description = "Supabase secret key" }

[tool.keypin.production.SUPABASE_SECRET_KEY.issuer]
kind = "supabase"
admin = "op://Acme/supabase token/credential"
project_ref = "abcdefghijklmnopqrst"
```

`admin` is a [personal access token](https://supabase.com/dashboard/account/tokens). A scoped token needs **API Keys**
Read-write and **API Key Secrets** Read on the project. `project_ref` is the 20 letters in the project's dashboard URL.

keypin won't rotate the secret key named `default`: Edge Functions that use `withSupabase({ auth: 'secret' })` accept
only that key, and a deleted key can't come back. Give each app its own named key, and rotate that. Each new key
gets a new name, so a function that checks `auth: 'secret:<name>'` rejects it.

## Cloudflare

```toml
[profiles.production]
CLOUDFLARE_API_TOKEN = { description = "Cloudflare deploy token" }

[tool.keypin.production.CLOUDFLARE_API_TOKEN.issuer]
kind = "cloudflare"
admin = "op://Acme/cloudflare token maker/credential"
```

`admin` is a token made with the
[Create additional tokens](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/) template, in
its own vault item. For an account API token (`cfat_`), add `account_id` and use an admin token with
**Account API Tokens** Edit on that account; the API calls it Account API Tokens Write.

The new token gets the old one's policies, IP filter and lifetime. Give the token a lifetime longer than its
`rotate_every`. A deploy token needs the [Workers role](https://developers.cloudflare.com/workers/authorization/workers/)
Admin to create a Worker, and Editor to deploy one that exists, so once the Worker exists, replace an Admin token with
an Editor one.

## OpenRouter

```toml
[profiles.production]
OPENROUTER_API_KEY = { description = "OpenRouter" }

[tool.keypin.production.OPENROUTER_API_KEY.issuer]
kind = "openrouter"
admin = "op://Acme/openrouter management key/credential"
```

`admin` is a read/write [management key](https://openrouter.ai/settings/management-keys), in its own vault item,
for the organization or the key's workspace. The new key gets the old key's credit limit, reset, BYOK setting,
lifetime and workspace. A limit that never resets starts again at $0 spent on the new key; the old key keeps its
credit until you revoke it.

## Google Cloud

For Google API keys such as `GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY` or `YOUTUBE_API_KEY`:

```toml
[profiles.production]
GOOGLE_MAPS_API_KEY = { description = "Google Maps" }

[tool.keypin.production.GOOGLE_MAPS_API_KEY.issuer]
kind = "google"
admin = "op://Acme/google key maker/credential"
project_number = "481537286014"
```

`project_number` is the project's number, digits only, from its Dashboard, not its project ID. `admin` is a service
account's [JSON key](https://cloud.google.com/iam/docs/keys-create-delete), the whole file, in its own vault item.
Give it **API Keys Admin** (`roles/serviceusage.apiKeysAdmin`) on that project, and turn on the API Keys API in the
service account's project. keypin doesn't use gcloud logins.

The new key gets the old key's API and application restrictions. Google Cloud keeps a deleted key for 30 days, so
you can restore it.

## Google Cloud service account keys

For a service account's JSON key file, such as `GOOGLE_APPLICATION_CREDENTIALS` content or Firebase Admin
credentials. The vault holds the whole file.

```toml
[profiles.production]
GOOGLE_APPLICATION_CREDENTIALS = { description = "Service account key file" }

[tool.keypin.production.GOOGLE_APPLICATION_CREDENTIALS.issuer]
kind = "google-service-account"
admin = "op://Acme/google key admin/credential"
```

`admin` is another service account's JSON key, in its own vault item, with **Service Account Key Admin**
(`roles/iam.serviceAccountKeyAdmin`) on the service account you rotate. Turn on the IAM API in the admin's project.

Organizations created since May 2024 block new keys with the `iam.disableServiceAccountKeyCreation` policy. To
rotate, an organization policy admin must turn it off for the project.

## ElevenLabs

```toml
[profiles.production]
ELEVENLABS_API_KEY = { description = "ElevenLabs" }

[tool.keypin.production.ELEVENLABS_API_KEY.issuer]
kind = "elevenlabs"
admin = "op://Acme/elevenlabs admin key/credential"
```

`admin` is a workspace admin's API key, in its own vault item; a restricted one needs access to service accounts.
ElevenLabs' API makes keys only for [service accounts](https://elevenlabs.io/docs/overview/administration/workspaces/service-accounts),
so replace a key that belongs to a person once with a service account key. The free plan has no service accounts.
Give the key the **User** read permission, and each app its own service account.

The new key gets the old key's permissions, credit limit, IP allowlist, concurrency limits and lifetime. A credit
limit starts unspent on the new key.

## AWS

An access key is two keys in `secretspec.toml`: the secret, and its ID. The secret's issuer names the ID's key with `key_id`:

```toml
[profiles.production]
AWS_SECRET_ACCESS_KEY = { description = "AWS secret access key" }
AWS_ACCESS_KEY_ID = { description = "AWS access key ID" }

[tool.keypin.production.AWS_SECRET_ACCESS_KEY.issuer]
kind = "aws"
admin = "op://Acme/aws admin/credential"
key_id = "AWS_ACCESS_KEY_ID"
```

Give `AWS_ACCESS_KEY_ID` the same destinations as the secret. `keypin rotate AWS_SECRET_ACCESS_KEY` saves and
publishes both. A destination without batch writes, such as GitHub Actions, gets them one after the other, so pause
new runs there until the rotation finishes.

`admin` holds the JSON that `aws iam create-access-key --user-name <admin user>` prints, for an IAM user of its own
that may list, create, update and delete access keys. The new key is for the same IAM user, and AWS allows two per
user, so that user must have no second key.

## SendGrid

```toml
[profiles.production]
SENDGRID_API_KEY = { description = "SendGrid" }

[tool.keypin.production.SENDGRID_API_KEY.issuer]
kind = "sendgrid"
admin = "op://Acme/sendgrid admin key/credential"
```

`admin` is an API key with **API Keys** Full Access, in its own vault item. A key can't give more than it has,
so it also needs every scope of the key you rotate; a Full Access key has them all. The new key gets the same scopes.

For a subuser's key, add `subuser = "<username>"` and use a key from the parent account. For an EU regional
subuser, add `region = "eu"`.

## Twilio

An API key is two keys in `secretspec.toml`, like [AWS](#aws): the secret, and its SID (`SK…`). The secret's issuer names the
SID's key with `key_id`:

```toml
[profiles.production]
TWILIO_API_SECRET = { description = "Twilio API key secret" }
TWILIO_API_KEY = { description = "Twilio API key SID" }

[tool.keypin.production.TWILIO_API_SECRET.issuer]
kind = "twilio"
admin = "op://Acme/twilio admin/credential"
key_id = "TWILIO_API_KEY"
```

`admin` holds JSON with `TWILIO_ACCOUNT_SID` and either `TWILIO_AUTH_TOKEN`, or `TWILIO_API_KEY` and
`TWILIO_API_SECRET` of a Main key or a Restricted key that may create, read and delete API keys. For a subaccount's
key, use the subaccount's own SID and credential.

The new key gets the old key's type, and a Restricted key's permissions. A Restricted key needs
`/twilio/phone-numbers/available-numbers/list`, which keypin uses to check its secret. keypin doesn't rotate
`TWILIO_AUTH_TOKEN`.

## xAI

```toml
[profiles.production]
XAI_API_KEY = { description = "xAI" }

[tool.keypin.production.XAI_API_KEY.issuer]
kind = "xai"
admin = "op://Acme/xai management key/credential"
```

`admin` is a [management key](https://console.x.ai/team/default/management-keys), not an API key, made by a team
admin, for the key's team or its organization. It needs to list, create and delete API keys, and to check their
propagation. There's no team ID to set. The new key gets the old key's ACLs, rate limits and lifetime.

## MongoDB Atlas

```toml
[profiles.production]
MONGODB_URI = { description = "MongoDB connection string" }

[tool.keypin.production.MONGODB_URI.issuer]
kind = "mongodb-atlas"
admin = "op://Acme/atlas service account/credential"
client_id = "mdb_sa_id_..."
project_id = "5f1a2b3c4d5e6f7a8b9c0d1e"
```

`admin` holds the client secret (`mdb_sa_sk_...`) of an Atlas
[service account](https://www.mongodb.com/docs/atlas/configure-api-access/) with **Project Database Access Admin** on
the project, and `client_id` is its client ID. keypin doesn't take API keys, which Atlas calls legacy.
`project_id` is the 24-character ID in the project's settings.

A changed password stops the old one at once, so keypin makes a second database user instead: user `app` becomes
`app-b`, then `app-a`, then `app-b` again. The new user gets the old user's roles, scopes, labels and description, and
the connection string keeps its hosts, database and options.

## random

For a secret your app makes itself, such as `AUTH_SECRET` or `SESSION_SECRET`:

```toml
[profiles.production]
AUTH_SECRET = { description = "Session signing secret" }

[tool.keypin.production.AUTH_SECRET.issuer]
kind = "random"
```

`rotate` makes 32 random bytes in base64, like `openssl rand -base64 32`; add `encoding = "hex"` for hex. Anything
signed with the old value stops working: with JWT sessions, everyone signs in again. There's nothing to revoke, so
`rotate` asks one `y`.

Better Auth encrypts stored data with its secret, and a new value can't read it. keypin refuses `BETTER_AUTH_SECRET`
and `BETTER_AUTH_SECRETS`; don't rotate `AUTH_SECRET` with `random` in a Better Auth app either. Add a version to
[`BETTER_AUTH_SECRETS`](https://better-auth.com/docs/reference/options#secrets) by hand instead.
