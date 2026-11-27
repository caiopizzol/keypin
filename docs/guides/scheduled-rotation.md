# Scheduled rotation

A GitHub Actions workflow in your repository rotates each due key on a schedule, and the old key keeps working until
a person approves revoking it. The setup below is for keys kept in 1Password and published to GitHub Actions; for
another vault, see [Other vaults](#other-vaults).

## Setup

1. Move each key and its issuer's `admin` item into a vault for this project alone, as
   [Service accounts](service-accounts.md) says, and point `[providers]` and each `admin` reference in
   `secretspec.toml` at it. In a shared vault, this repository's token would reach other projects' keys.
2. In Settings → Environments, create the environment `rotation`, and limit its deployment branches to the default
   branch. A private repository on GitHub Free has no environment secrets. There, save steps 3 and 4's secrets and
   variable in the repository instead of `rotation`, and delete `environment:` from the workflow, `--env rotation`
   from the command below, and `environment = "rotation"` from step 7's publish targets.
3. Create a service account with write access to that vault, and save its token as the secret
   `OP_SERVICE_ACCOUNT_TOKEN` in `rotation`. By default, only 1Password owners and administrators can create one;
   anyone else needs them to
   [grant access](https://www.1password.dev/service-accounts/manage-service-accounts#manage-who-can-create-service-accounts).
   1Password shows the token only once; this saves it without printing it:

   ```sh
   op service-account create "acme-web rotation" --vault "Acme:read_items,write_items" --expires-in 89d --raw |
     gh secret set OP_SERVICE_ACCOUNT_TOKEN --env rotation -R acme/web
   ```

   1Password allows `--expires-in` only under 90 days, and keypin can't read when it ends, so
   [set a reminder](service-accounts.md#expiry) to replace the token before then. Without `--expires-in`, the token
   keeps write access to the vault until you delete it. Admin keys stay in the vault, not in repo secrets.

4. [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
   with no webhook and the repository permission Secrets set to Read and write, and install it on this repository
   only. Keys published to an environment also need Environments set to Read and write. In `rotation`, save its
   Client ID as the variable `KEYPIN_APP_CLIENT_ID` and a private key it generates as the secret
   `KEYPIN_APP_PRIVATE_KEY`. The workflow's own `GITHUB_TOKEN` can't write secrets.
5. Add the workflow below as `.github/workflows/rotate-keys.yml`, pinned to the keypin version you run on your
   laptop, 0.46.0 or later: earlier versions refuse an App's token. It runs daily at 06:17 UTC; change the
   [schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
   to run at other times.
6. Every run, manual ones too, pushes `.keypin/` to the default branch with the workflow's `GITHUB_TOKEN`, which a
   rule requiring a pull request or a status check rejects. Keep the branch free of such a rule, or keep `.keypin/` on
   [a branch of its own](#a-protected-default-branch).
7. `keypin check` asks for the workflow's two secrets. The simple way is to
   [ignore](../reference/secretspec-toml.md#toolkeypin) them:

   ```toml
   [tool.keypin]
   ignore = ["KEYPIN_APP_PRIVATE_KEY", "OP_SERVICE_ACCOUNT_TOKEN"]
   ```

   Or declare them in a profile no app runs with, so `keypin publish --all --profile rotation` writes them and
   `keypin status` shows when they're due. `inherit = false` keeps other profiles' keys out of it, not their vault:
   keep these two in a vault the service account can't read, through a provider of their own (`bootstrap` below,
   added to your `[providers]`), or it can read `KEYPIN_APP_PRIVATE_KEY`. In step 3, pipe the token to
   `secretspec set OP_SERVICE_ACCOUNT_TOKEN --profile rotation`, and give each item a
   [rotated date](../integrations/vaults/1password.md#rotated-date). Without a `production` profile, put this one
   above the last, which `publish` and `rotate` use.

   ```toml
   [providers]
   bootstrap = "onepassword://Bootstrap"
   
   [profiles.rotation]
   KEYPIN_APP_PRIVATE_KEY = { description = "GitHub App private key for scheduled rotation" }
   OP_SERVICE_ACCOUNT_TOKEN = { description = "1Password service account for scheduled rotation" }
   
   [profiles.rotation.defaults]
   inherit = false
   providers = ["bootstrap"]
   
   [tool.keypin.rotation.KEYPIN_APP_PRIVATE_KEY]
   publish = [{ to = "github-actions", repo = "acme/web", environment = "rotation" }]
   
   [tool.keypin.rotation.OP_SERVICE_ACCOUNT_TOKEN]
   publish = [{ to = "github-actions", repo = "acme/web", environment = "rotation" }]
   ```

8. A runner starts with no receipts, so a first write would wait for approval. From your laptop, publish each key,
   run `keypin rotate --due`, and commit `.keypin/`. It asks before it rotates a key that's due: answer `n` to only
   record what you published.
9. Run the workflow with **check setup** checked. `keypin rotate --check` changes nothing, and fails with the next step
   if a key, an admin key, the GitHub App or a receipt isn't ready. It can't see the App's Secrets permission
   without writing a secret, so check that one yourself.

```yaml
name: rotate keys

on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:
    inputs:
      check_setup:
        description: Check the setup, and rotate nothing
        type: boolean
        default: false
      approve_revoke:
        description: Revoke the old keys waiting for approval
        type: boolean
        default: false
      key:
        description: With approve revoke, only this key; empty for every key that waits
        type: string

permissions:
  contents: write

concurrency: rotate-keys

jobs:
  rotate:
    runs-on: ubuntu-latest
    environment: rotation
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.repository.default_branch }}
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
          package-manager-cache: false
      - run: npm install -g keypin@0.46.1 # x-release-please-version
      - id: app
        uses: actions/create-github-app-token@f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc # v3.4.0
        with:
          client-id: ${{ vars.KEYPIN_APP_CLIENT_ID }}
          private-key: ${{ secrets.KEYPIN_APP_PRIVATE_KEY }}
      - run: gh auth login --hostname github.com --with-token --insecure-storage <<< "$TOKEN"
        env:
          GH_CONFIG_DIR: ${{ runner.temp }}/gh
          TOKEN: ${{ steps.app.outputs.token }}
      - run: |
          if [ "$CHECK" = true ]; then
            keypin rotate --check
          elif [ "$APPROVE" = true ]; then
            keypin rotate --approve-revoke ${KEY:+"$KEY"}
          else
            keypin rotate --due --yes
          fi
        env:
          CHECK: ${{ inputs.check_setup }}
          APPROVE: ${{ inputs.approve_revoke }}
          KEY: ${{ inputs.key }}
          GH_CONFIG_DIR: ${{ runner.temp }}/gh
          KEYPIN_1PASSWORD: service-account
          OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
      - if: always()
        run: |
          git add -- $(git ls-files --others --modified -- .keypin/rotation.json .keypin/status.json)
          git diff --cached --quiet && exit 0
          git config user.name keypin
          git config user.email keypin@users.noreply.github.com
          git commit -m "chore: record key rotation"
          for try in 1 2 3; do git pull --rebase && git push && exit 0; sleep 10; done
          exit 1
```

## A protected default branch

When a rule on the default branch rejects the workflow's push, keep `.keypin/` on a branch no rule covers, such as
`keypin/state`.

In the workflow, add `STATE_BRANCH` to the job, restore `.keypin/` after checkout, and replace the last step:

```yaml
jobs:
  rotate:
    env:
      STATE_BRANCH: keypin/state
    steps:
      # checkout, then:
      - name: Restore keypin state
        run: |
          git fetch --no-tags origin "$STATE_BRANCH"
          git update-ref refs/keypin/state FETCH_HEAD
          git checkout refs/keypin/state -- .keypin
          git reset --quiet -- .keypin
      # setup-node through keypin rotate, then:
      - name: Save keypin state
        if: always()
        run: |
          git worktree add --quiet --detach "$RUNNER_TEMP/state" refs/keypin/state
          cp .keypin/rotation.json .keypin/status.json "$RUNNER_TEMP/state/.keypin/"
          cd "$RUNNER_TEMP/state"
          git add .keypin
          git diff --cached --quiet && exit 0
          git -c user.name=keypin -c user.email=keypin@users.noreply.github.com commit --quiet -m "chore: record key rotation"
          git push origin "HEAD:refs/heads/$STATE_BRANCH"
```

In step 8, push `.keypin/` to that branch in place of committing it to the default branch:

```sh
git switch -c keypin/state
git add .keypin
git commit -m "chore: record key rotation"
git push -u origin keypin/state
git switch -
```

Before a later `keypin rotate` on your laptop, restore `.keypin/` with
`git fetch origin keypin/state && git checkout FETCH_HEAD -- .keypin`, and afterward commit it to that branch. Don't
run it while the workflow runs: the save step commits on the state it restored, so a run that changed state then
fails to push rather than overwrite yours.

## Other vaults

With Infisical or AWS Secrets Manager, the job signs in to the vault with GitHub Actions OIDC, so the repo stores no
vault token. Set up the identity or role on the vault's page
([Infisical](../integrations/vaults/infisical.md#signing-in-from-github-actions),
[AWS Secrets Manager](../integrations/vaults/aws-secrets-manager.md#signing-in-from-github-actions)), with write
access to the keys and their admin keys. Because the job sets `environment: rotation`, its OIDC subject ends in
`:environment:rotation`, not the branch, so trust that subject. In the workflow, add `id-token: write` under
`permissions`, and set `KEYPIN_INFISICAL_IDENTITY_ID` or `KEYPIN_AWS_ROLE_ARN` in place of `KEYPIN_1PASSWORD` and
`OP_SERVICE_ACCOUNT_TOKEN`, which then needn't be ignored. With Bitwarden Secrets Manager, save `BWS_ACCESS_TOKEN` as
an Actions secret, set it in their place, and ignore it instead.

Doppler keeps no rotated date, so scheduled rotation never rotates a Doppler key; see
[Doppler](../integrations/vaults/doppler.md#rotated-date).

## Runs

`rotate --due` rotates each key that is due and has an `issuer`, and says why it skips the others. Without a
terminal, `--yes` approves only routine writes, as in [publishing](publishing.md#steps). It exits 0 when no one needs
to act, even while an old key waits for approval; 3 while a key is due and its old key still waits, every run until
someone approves (`--check` too); and 1 when something failed, or a key's rotated date is missing or couldn't be read.

Every run also checks the credentials it uses, on days nothing is due too. It fails when a Cloudflare admin token
expires within 7 days of the key's next due date. A [service account](service-accounts.md#expiry)'s expiry can't be read.

GitHub emails a failed scheduled run only to the account that last changed the `schedule` or re-enabled the workflow,
and only if it turned on Actions [notifications](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs).
To approve, run the workflow with **approve revoke** checked, and a key to approve only that one. keypin never
revokes the Resend key a first rotation replaces: once nothing uses it, delete it at Resend yourself.

Each run pushes `.keypin/rotation.json` and `.keypin/status.json` ([Files and state](../reference/files-and-state.md)).
Neither holds a value, but `rotation.json` holds each key's provider ID, which can name a project or service account.
In a public repository, anyone can see which keys exist and when an old one still works. Anyone who can push
`.keypin/` can change those IDs, so keypin signs each rotation with the new key's value and revokes an old key only
when that signature matches the vault's value and the provider confirms it isn't the vault's key. A rotation with no
signature, such as one an older keypin recorded, isn't revoked: delete its old key yourself, then run `keypin rotate
<KEY>` in a terminal to record it.
