# Publishing

`keypin publish` reads a key from your vault and writes it to every destination listed for it in `secretspec.toml`.

```sh
keypin publish API_TOKEN                     # production, or the last profile
keypin publish API_TOKEN --profile staging   # another profile
keypin publish --all                         # every key with destinations, with one approval
keypin publish --all --plan                  # show the plan and write nothing
```

Run `keypin check` first: it lists what's missing.

## Destinations

List each place `publish` writes the key in the key's `[tool.keypin.<profile>.<KEY>]` table, under `publish`. The
key must be declared in that profile or in `[profiles.default]`. `keypin check` prints these tables for each secret
a workflow or Worker needs, with the Worker of a wrangler `[env.staging]` under the profile `staging`.

```toml
[profiles.production]
API_TOKEN = { description = "API token" }

[[tool.keypin.production.API_TOKEN.publish]]
to = "github-actions"
repo = "owner/repo"

[[tool.keypin.production.API_TOKEN.publish]]
to = "cloudflare-worker"
account = "11111111111111111111111111111111" # Cloudflare account ID
worker = "my-worker"

[[tool.keypin.production.API_TOKEN.publish]]
to = "vercel-project"
team = "acme" # team ID or slug
project = "my-project"
environment = "production"

[[tool.keypin.production.API_TOKEN.publish]]
to = "supabase-functions"
project_ref = "abcdefghijklmnopqrst" # 20-letter project ref

[[tool.keypin.production.API_TOKEN.publish]]
to = "netlify-project"
team = "acme" # team slug
project = "my-project.netlify.app"
context = "production"

[[tool.keypin.production.API_TOKEN.publish]]
to = "railway-service"
project = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" # project ID
environment = "production"
service = "api"

[[tool.keypin.production.API_TOKEN.publish]]
to = "convex-deployment"
url = "https://happy-animal-123.convex.cloud"

[[tool.keypin.production.API_TOKEN.publish]]
to = "fly-app"
app = "my-app"

[[tool.keypin.production.API_TOKEN.publish]]
to = "gitlab-project"
project = "acme/billing"
```

`secretspec.toml` says where a key goes, not who writes it, so every teammate publishes from the same file:

- **GitHub:** Actions secrets, as the login in `git config github.account`, or else the active `gh` login. It needs
  write access to the repo. Add `environment = "production"` to write a secret of that GitHub environment instead of a repo secret; the
  environment must already exist. The two are separate destinations. keypin doesn't publish to GitHub Enterprise
  Server or ghe.com.
- **Cloudflare:** Worker secrets, with the `wrangler` login or `KEYPIN_CLOUDFLARE_API_TOKEN` (see
  [Troubleshooting](../reference/troubleshooting.md#signing-in-to-cloudflare)). It must reach the pinned `account`, and the Worker must already
  exist. Writing a Worker secret deploys a new version of the Worker, so deploy the Worker's latest version first;
  `--all` writes up to 100 of a Worker's keys in one version. keypin doesn't publish to Pages projects or Workers
  for Platforms namespaces.
- **Vercel:** Sensitive variables, one per `environment`: `production`, `preview`, `development` or a custom
  environment's name. It uses a token in `KEYPIN_VERCEL_TOKEN`, for the `team` or the project, and doesn't read the
  `vercel` login or `VERCEL_TOKEN`. Vercel uses a new value only in new deployments, so redeploy after publishing;
  keypin doesn't. It leaves Git branch variables alone.
- **Supabase:** Edge Function secrets, with a personal access token in `KEYPIN_SUPABASE_ACCESS_TOKEN` with Edge
  Function Secrets Read-write on the project. keypin doesn't read the `supabase` login or `SUPABASE_ACCESS_TOKEN`.
  Functions read a new value at once, with no redeploy.
- **Netlify:** secret variables, one value per `context`: `production`, `deploy-preview`, `branch-deploy` or
  `dev-server`. It uses a personal access token in `KEYPIN_NETLIFY_TOKEN`, from a member of the `team`, and doesn't
  read the `netlify` login or `NETLIFY_AUTH_TOKEN`. Netlify uses a new value only from the next build and deploy,
  so redeploy after publishing; keypin doesn't. It leaves other contexts and branch values alone. For `netlify dev`, run `secretspec run -- netlify dev`.
- **Railway:** service variables, with a workspace or account token in `KEYPIN_RAILWAY_TOKEN` that reaches the
  `project`, or a project token for the `environment`. keypin doesn't read the `railway` login, `RAILWAY_TOKEN` or
  `RAILWAY_API_TOKEN`. `environment` and `service` take a name or an ID. Railway stages the change and uses the new
  value only from the service's next deploy, so deploy after publishing; keypin doesn't. keypin can't seal a
  variable through Railway's API; seal it once in Railway, and later writes keep it sealed.
- **Convex:** environment variables, with a deploy key for the deployment in `url`, with `deployment:env:write`, in
  `KEYPIN_CONVEX_DEPLOY_KEY`. keypin doesn't read the `npx convex` login or `CONVEX_DEPLOY_KEY`. Changing a
  variable invalidates every subscription. Cron definitions read it only on the next deploy.
- **Fly.io:** app secrets, with a deploy token for the `app` or an org token for its organization, in
  `KEYPIN_FLY_API_TOKEN`. Add `org = "<org slug>"` to also pin the organization. keypin doesn't read the `fly` login
  or `FLY_API_TOKEN`. Fly.io stages the new value; Machines use it only after `fly secrets deploy` or the app's next
  deploy, which restarts them. keypin doesn't run either.
- **GitLab:** masked CI/CD variables of a `project` or `group`, with the `glab` login for the host, or a personal,
  project or group access token with the `api` scope in `KEYPIN_GITLAB_TOKEN`. It needs the Maintainer role on a
  project, or Owner on a group. A CI/CD job token can't change variables. keypin doesn't sign in with
  `GITLAB_TOKEN`. Add `host` for a self-managed instance, and `environment_scope` to write a project variable for
  one environment instead of `*`. A new variable is also hidden. GitLab can't hide a variable that already exists,
  so keypin masks it and leaves its other settings, such as protected, alone. The next pipeline uses the new value.

## Steps

1. **Accounts:** it checks that each login reaches the account the destination names, and stops if one doesn't.
2. **Plan:** it reads the value and shows what it will write where. It skips a destination when this machine's
   receipt shows it already got this value; keypin never reads a destination's secret.
3. **Approval:** you answer `y`.
4. **Receipts:** it records each write on this machine, so a rerun skips destinations that are done.

A first write to a destination, a changed account and a changed vault item always need a `y` in a terminal; `--yes`
approves only routine updates. A teammate's machine has no receipts, so their first publish counts as a first write.

## --plan

`--plan` runs the account checks and shows the full plan, then stops, even without a terminal. It reads the value,
so 1Password may ask you to approve it, but never writes or prints one. It exits 3 when the plan would write and 0
when there's nothing to write.

## Every key

`--all` publishes every key that has destinations in the profile, with one plan and one approval. If a write
fails, it stops and keeps the receipts so far; run it again to continue.

keypin never deletes a secret from a destination you remove from the file.

## Reading keys in CI

A CI job can read its keys from your vault at job time with `secretspec run`, instead of getting copies from
`publish`. The job needs secretspec, the 1Password CLI for a 1Password provider, and the vault's credentials, such as
a [1Password service account](service-accounts.md) token. See secretspec's
[GitHub Actions guide](https://secretspec.dev/ci/github-actions/).

```yaml
- run: secretspec run --profile production -- <command>
  env:
    OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
```

`keypin check` doesn't ask to publish a secret that the job's profile declares and that only `secretspec run` steps
use. The profile is the one in `--profile` or `-P`, else `SECRETSPEC_PROFILE` in the step, job or workflow, else
`default`. Add `OP_SERVICE_ACCOUNT_TOKEN`, or your vault's token, to
[`ignore`](../reference/secretspec-toml.md#toolkeypin).

`keypin rotate` saves a new key to the vault, where `secretspec run` reads it, so such a key needs no destination. To
move a key to `secretspec run`:

1. Change the workflow, and check that it runs.
2. Remove the GitHub entry from the key's `publish` in `[tool.keypin.<profile>.<KEY>]`, so `keypin publish` and
   `keypin rotate` stop writing it.
3. Delete the secret from the repository or environment it was published to, such as
   `gh secret delete API_TOKEN --repo owner/repo`. keypin never deletes a copy it published.
