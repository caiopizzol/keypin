# Infisical

keypin can read keys from [Infisical](https://infisical.com) instead of 1Password. `run`, `check`, `status`,
`publish` and `rotate` work; `import` creates 1Password items, so add the secrets in Infisical yourself.

1. Create a [machine identity](https://infisical.com/docs/documentation/platform/identities/universal-auth) with
   Universal Auth, and add it to each project keypin reads, with read access to its environments. `keypin rotate`
   also needs write access, to save the new key.
2. Pin your organization in `keypin.toml`, and reference each secret by project, environment and name:

   ```toml
   [infisical]
   organization = "acme"
   url = "https://eu.infisical.com"
   
   [keys.STRIPE_KEY]
   rotate_every = "90d"
   dev = "infisical://billing/dev/STRIPE_KEY"
   prod = "infisical://billing/prod/payments/STRIPE_KEY"
   ```

   `organization` is the slug in your organization's settings. Leave out `url` for US Cloud; set it for EU Cloud or
   a self-hosted instance. `billing` is the project's slug (or its ID), `dev` the environment's slug, and folders go
   before the name.

3. Set the identity's client ID and secret on the machine:

   ```sh
   export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=...
   export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=...
   ```

   For another auth method, such as Kubernetes or AWS, set an access token from `infisical login` instead. keypin
   uses the client ID and secret when both are set:

   ```sh
   export INFISICAL_TOKEN=$(infisical login --method=<method> ... --silent --plain)
   ```

   In GitHub Actions, keypin can sign in with OIDC instead; see [below](#pulling-in-github-actions).

keypin never passes these variables to the command `keypin run` starts. Before it reads, keypin checks that the
identity belongs to the pinned organization and refuses another.

For `keypin status`, add a `rotated` entry to each secret's metadata with the day the value last changed, as
`YYYY-MM-DD`.

## Pulling in GitHub Actions

A GitHub Actions job can sign in to Infisical with OIDC and read a key itself, without a published copy or a client
secret. List the job in the map with a [`pull`](configuration.md#pulling-in-ci) entry, then:

1. Create a machine identity with [OIDC Auth](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github)
   instead of Universal Auth, and add it to the project with read access. Set the discovery URL and issuer to
   `https://token.actions.githubusercontent.com`, the audience to `https://github.com/<owner>`, and the subject to
   the one GitHub gives your repo's branch, such as `repo:owner@123456/repo@456789:ref:refs/heads/main`. See
   [the subject formats](aws-secrets-manager.md#pulling-in-github-actions) for older repos and GitHub environments.
   Set **Access Token TTL** and **Access Token Max TTL** to a few minutes, enough for the job's reads; both default
   to 30 days.

2. In the job, give keypin the identity's ID. keypin exchanges GitHub's token for a short-lived Infisical access
   token, reads, and revokes it before the command starts:

   ```yaml
   permissions:
     id-token: write
     contents: read
   steps:
     - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
     - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
       with:
         node-version: 24
     - run: npm install -g keypin
     - run: keypin run --env prod --only STRIPE_KEY -- <command>
       env:
         KEYPIN_INFISICAL_IDENTITY_ID: <machine identity ID>
   ```

   Set `KEYPIN_INFISICAL_AUDIENCE` if the identity expects another audience. keypin sends GitHub's token only to
   Infisical Cloud; for a self-hosted `url`, also set `KEYPIN_INFISICAL_URL` to the same address.

A job on another branch gets no access token. A value you change in Infisical reaches the jobs without `publish`.
