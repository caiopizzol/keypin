# Publishing

`keypin publish` reads a key from 1Password and writes it to every destination listed for it.

```sh
keypin publish API_TOKEN             # the prod entry
keypin publish API_TOKEN --env dev   # another environment
keypin publish --all                 # every key with destinations, with one approval
keypin publish --all --plan          # show the plan and write nothing
```

Run `keypin check` first: it lists what's missing.

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

[[keys.API_TOKEN.prod.publish]]
to = "railway-service"
project = "<project ID>"
environment = "production"
service = "api"

[[keys.API_TOKEN.prod.publish]]
to = "convex-deployment"
url = "https://happy-animal-123.convex.cloud"

[[keys.API_TOKEN.prod.publish]]
to = "fly-app"
app = "my-app"

[[keys.API_TOKEN.prod.publish]]
to = "gitlab-project"
project = "acme/billing"
```

The map says where a key goes, not who writes it, so every teammate publishes from the same map:

- **GitHub:** Actions secrets, as the login in `git config github.account`, or else the active `gh` login. It needs
  write access to the repo. GitHub reserves secret names that start with `GITHUB_`. Add
  `environment = "production"` to write a secret of that GitHub environment instead of a repo secret; the
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
  keypin doesn't. It stops rather than change a variable that also covers another environment, and leaves Git
  branch variables alone.
- **Supabase:** Edge Function secrets, with a personal access token in `KEYPIN_SUPABASE_ACCESS_TOKEN` with Edge
  Function Secrets Read-write on the project. keypin doesn't read the `supabase` login or `SUPABASE_ACCESS_TOKEN`.
  Functions read a new value at once, with no redeploy. Supabase reserves names that start with `SUPABASE_`, so
  keypin refuses them.
- **Netlify:** secret variables, one value per `context`: `production`, `deploy-preview`, `branch-deploy` or
  `dev-server`. It uses a personal access token in `KEYPIN_NETLIFY_TOKEN`, from a member of the `team`, and doesn't
  read the `netlify` login or `NETLIFY_AUTH_TOKEN`. Netlify uses a new value only from the next build and deploy,
  so redeploy after publishing; keypin doesn't. It stops rather than write to a variable not marked as secret. It
  leaves other contexts and branch values alone. For `netlify dev`, run `keypin run -- netlify dev`.
- **Railway:** service variables, with a workspace or account token in `KEYPIN_RAILWAY_TOKEN` that reaches the
  `project`, or a project token for the `environment`. keypin doesn't read the `railway` login, `RAILWAY_TOKEN` or
  `RAILWAY_API_TOKEN`. `environment` and `service` take a name or an ID. Railway stages the change and uses the new
  value only from the service's next deploy, so deploy after publishing; keypin doesn't. keypin can't seal a
  variable through Railway's API; seal it once in Railway, and later writes keep it sealed. Railway reserves names
  that start with `RAILWAY_`, so keypin refuses them.
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
  so keypin masks it and leaves its other settings, such as protected, alone. GitLab masks only a value of 8 or more
  characters without spaces or line breaks; keypin refuses any other. The next pipeline uses the new value.

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

## Pulling in CI

A CI job can sign in to your vault and read a key itself, instead of getting a copy from `publish`. `pull` doesn't
set up that sign-in (see [Service accounts](service-accounts.md) for 1Password, and Pulling in GitHub Actions for
[AWS Secrets Manager](../integrations/vaults/aws-secrets-manager.md#pulling-in-github-actions),
[Infisical](../integrations/vaults/infisical.md#pulling-in-github-actions) and [Doppler](../integrations/vaults/doppler.md#pulling-in-github-actions)); it lists the job, so
the map still says who reads the key:

```toml
[keys.API_TOKEN.prod]
from = "op://my-project/prod api token/credential"

[[keys.API_TOKEN.prod.pull]]
by = "github-actions"
repo = "owner/repo"
environment = "production" # optional: only the jobs in this GitHub environment
```

The job runs `keypin run --env prod --only API_TOKEN -- <command>`; without `--env`, `run` uses the first
environment. `run` doesn't read `pull`: your vault decides which jobs it lets in. `run` doesn't pass GitHub's OIDC
token-request variables to the command.

- `publish` writes nothing for a key that is only pulled, and `publish --all` skips it.
- `rotate` and `rotate --due` rotate it like a key with destinations. Once your vault holds the new key, the jobs
  read it, so only the revoke is left.
- `status` lists who pulls each key, apart from its destinations.
- `check` reads the secret names stored in each repo or environment that pulls a key, and reports a copy left
  there, or a workflow that still uses `secrets.API_TOKEN`.

To move a key from `publish` to `pull`, replace its `publish` entry with a `pull` entry for the same place: the map
rejects a place in both. Change the workflow to `keypin run`, then delete the old secret, such as
`gh secret delete API_TOKEN --repo owner/repo --env "production"`. keypin never deletes a copy it published.
