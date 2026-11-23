# Scheduled rotation

A GitHub Actions workflow in your repository can rotate keys on a schedule. It runs on your runners, never on a
keypin server. keypin creates each new key, saves it to your vault and publishes it, then stops: the old key keeps
working until a person approves deleting it. The setup below is for keys kept in 1Password and published to GitHub
Actions; for another vault, see [Other vaults](#other-vaults).

## Setup

1. Move each key and its issuer's `admin` item into a vault for this project alone, as
   [Service accounts](service-accounts.md) says, and point `[providers]` and each `admin` reference in
   `secretspec.toml` at it. In a shared vault, this repository's token would reach other projects' keys.
2. In Settings → Environments, create the environment `rotation`, and limit its deployment branches to the default
   branch. A private repository on GitHub Free has no environment secrets. There, use repo secrets: delete
   `environment:` from the workflow, `--env rotation` from the command below, and `environment = "rotation"` from
   step 7's publish targets.
3. Create a service account with write access to that vault, and save its token as the secret
   `OP_SERVICE_ACCOUNT_TOKEN` in `rotation`. 1Password shows the token only once; this saves it without printing it:

   ```sh
   op service-account create "acme-web rotation" --vault "Acme:read_items,write_items" --expires-in 365d --raw |
     gh secret set OP_SERVICE_ACCOUNT_TOKEN --env rotation -R acme/web
   ```

   Without `--expires-in`, it never expires; with it, [set a reminder](service-accounts.md#expiry) to make a new one
   before that day. keypin reads each admin key from the vault, so it isn't a secret of its own.

4. Create a fine-grained GitHub token for this repository only, with the Secrets permission set to Read and write,
   and save it as the secret `KEYPIN_GITHUB_TOKEN` in `rotation`. Keys published to an environment also need
   Environments set to Read and write. The workflow's own `GITHUB_TOKEN` can't write secrets.
5. Add the workflow below as `.github/workflows/rotate-keys.yml`. Pin the keypin version you run on your laptop;
   `keypin check` notes when they differ. It runs daily at 06:17 UTC, though GitHub can delay or skip a scheduled run;
   change the [schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
   to run at other times. `GH_CONFIG_DIR` and `--insecure-storage` keep `gh`'s login in the job's temporary folder,
   which the runner empties after the job, not on a self-hosted runner's disk or keyring.
6. Every run, manual ones too, pushes `.keypin/` to the default branch with the workflow's `GITHUB_TOKEN`, which a
   rule requiring a pull request or a status check rejects. Keep the branch free of such a rule, or give
   `KEYPIN_GITHUB_TOKEN` Contents write from an account that may bypass it, pass it to checkout as `token:`, and add
   `paths-ignore: [".keypin/**"]` to your `on: push` workflows. Anyone with that token can then push code there.
7. `keypin check` asks for the workflow's two secrets. The simple way is to
   [ignore](../reference/secretspec-toml.md#toolkeypin) them:

   ```toml
   [tool.keypin]
   ignore = ["KEYPIN_GITHUB_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN"]
   ```

   Or declare them in a profile no app runs with, so `keypin publish --all --profile rotation` writes them and
   `keypin status` shows when they're due. `inherit = false` keeps other profiles' keys out of it, not their vault:
   keep these two in a vault the service account can't read, through a provider of their own (`bootstrap` below,
   added to your `[providers]`), or it can read `KEYPIN_GITHUB_TOKEN`. In step 3, pipe the token to
   `secretspec set OP_SERVICE_ACCOUNT_TOKEN --profile rotation`, and give each item a
   [rotated date](../integrations/vaults/1password.md#rotated-date). Without a `production` profile, put this one
   above the last, which `publish` and `rotate` use. A scheduled run can't read that vault, so it notes it couldn't
   refresh these two dates and keeps the last ones in `.keypin/status.json`; the rotation itself still runs.

   ```toml
   [providers]
   bootstrap = "onepassword://Bootstrap"
   
   [profiles.rotation]
   KEYPIN_GITHUB_TOKEN = { description = "GitHub token for scheduled rotation" }
   OP_SERVICE_ACCOUNT_TOKEN = { description = "1Password service account for scheduled rotation" }
   
   [profiles.rotation.defaults]
   inherit = false
   providers = ["bootstrap"]
   
   [tool.keypin.rotation.KEYPIN_GITHUB_TOKEN]
   rotate_every = "80d" # before the token expires
   publish = [{ to = "github-actions", repo = "acme/web", environment = "rotation" }]
   
   [tool.keypin.rotation.OP_SERVICE_ACCOUNT_TOKEN]
   publish = [{ to = "github-actions", repo = "acme/web", environment = "rotation" }]
   ```

8. A runner starts with no receipts, so a first write would wait for approval. From your laptop, publish each key,
   run `keypin rotate --due`, and commit `.keypin/`. It asks before it rotates a key that's due: answer `n` to only
   record what you published.
9. Run the workflow with **check setup** checked. `keypin rotate --check` changes nothing, and fails with the next step
   if a key, an admin key, the GitHub token or a receipt isn't ready. It can't see the token's Secrets permission
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
      - run: npm install -g keypin@0.40.0 # x-release-please-version
      - run: gh auth login --hostname github.com --with-token --insecure-storage <<< "$TOKEN"
        env:
          GH_CONFIG_DIR: ${{ runner.temp }}/gh
          TOKEN: ${{ secrets.KEYPIN_GITHUB_TOKEN }}
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

Doppler keeps no rotated date, so `rotate --due` never rotates a Doppler key, and `--check` fails for one with a
`rotate_every`. [`rotate_every`](../reference/secretspec-toml.md#toolkeypin) applies to the key name in every
profile, so set it to `"never"` or remove it wherever it's set, which stops scheduled rotation in every profile, or
keep the key in a vault that keeps dates. Rotate it by hand with `keypin rotate <KEY> --profile <name>`. A job can
still sign in to Doppler with [OIDC](../integrations/vaults/doppler.md#signing-in-from-github-actions) to publish.

## Runs

`rotate --due` rotates each key that is due and has an `issuer`, and says why it skips the others. Without a
terminal, `--yes` approves only routine writes, as in [publishing](publishing.md#steps). It exits 0 when no one needs
to act, even while an old key waits for approval; 3 while a key is due and its old key still waits, every run until
someone approves (`--check` too); and 1 when something failed, or a key's rotated date is missing or couldn't be read.

Every run also checks the credentials it uses, on days nothing is due too. It warns when the GitHub token expires in
under 14 days and fails under 7, and fails when a Cloudflare admin token expires within 7 days of the key's next due
date. A [service account](service-accounts.md#expiry)'s expiry can't be read.

GitHub emails a failed scheduled run only to the account that last changed the `schedule` or re-enabled the workflow,
and only if it turned on Actions [notifications](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs).
To approve, run the workflow with **approve revoke** checked, and a key to approve only that one. keypin deletes an
old key only if every destination got the new one, and only in a terminal if a destination taken out of
`secretspec.toml` may still use it. Resend can't tell keypin which key the vault holds, so keypin never revokes the
key a first rotation replaces: once nothing uses it, delete it at Resend yourself. Later rotations wait for approval.

Each run pushes `.keypin/rotation.json`, what the next run needs to continue, and `.keypin/status.json`, each key's last
rotation for the hosted console. Neither holds a value or a vault reference. `rotation.json` holds the provider's ID
for the new and the old key, which can name a project or service account, and a short hash of each key. In a public
repository, anyone can see which keys exist and when an old one still works.
