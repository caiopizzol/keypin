# Scheduled rotation

A GitHub Actions workflow in your repository can rotate keys on a schedule. It runs on your runners, never on a
keypin server. keypin creates each new key, saves it to your vault and publishes it, then stops: the old key keeps
working until a person approves deleting it. For now, it supports keys kept in 1Password and published to GitHub
Actions.

## Setup

1. Move each key and its issuer's `admin` item into a vault you create, and update the references in `keypin.toml`.
   A [service account](service-account.md) can't open the Private, Personal or Employee vaults, or the default
   Shared vault. `rotate --due` skips a key without `rotate_every` in the map or a `rotated` date on its item.
2. Create a service account with write access to that vault, and save its token as the Actions secret
   `OP_SERVICE_ACCOUNT_TOKEN`. keypin reads each admin key from the vault, so it isn't a secret of its own.
3. Create a fine-grained GitHub token for this repository only, with the Secrets permission set to Read and write,
   and save it as the Actions secret `KEYPIN_GITHUB_TOKEN`. Keys published to an environment also need Environments
   set to Read and write. The workflow's own `GITHUB_TOKEN` can't write secrets.
4. Add the workflow below as `.github/workflows/rotate-keys.yml`. Every run, manual ones too, reads and pushes
   `.keypin/` on the default branch, so the workflow must be allowed to push to it. Pin the keypin version you run on
   your laptop, and bump both together.
5. [Ignore](configuration.md#ignored-keys) the two secrets at the top of `keypin.toml`, or `keypin check` asks you to
   add them:

   ```toml
   ignore = ["KEYPIN_GITHUB_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN"]
   ```

6. A runner starts with no receipts, so a first write would wait for approval. From your laptop, publish each key,
   run `keypin rotate --due`, and commit `.keypin/`. It asks before it rotates a key that's due: answer `n` to only
   record what you published.
7. Run the workflow with **check setup** checked. `keypin rotate --check` changes nothing, and fails with the next step
   if a key, an admin key, the GitHub token or a receipt isn't ready. It can't see the token's Secrets permission
   without writing a secret, so check that one yourself.

```yaml
name: rotate keys

on:
  schedule:
    - cron: "0 6 * * 1"
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
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.repository.default_branch }}
      - run: npm install -g keypin@0.32.0 # x-release-please-version
      - run: gh auth login --hostname github.com --with-token <<< "$TOKEN"
        env:
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

If your plan has environments with deployment branches, keep both secrets in an environment only the default branch can
use, and add `environment: <name>` to the job.

## Runs

`rotate --due` rotates each key that is due and has an `issuer` and destinations, and says why it skips the others.
Without a terminal, `--yes` approves only routine writes, as in [publishing](publishing.md#steps).

When an old key waits for approval, the run passes with a warning; a red run means something failed. To approve, run
the workflow with **approve revoke** checked, and a key to approve only that one. keypin deletes an old key only if
every destination got the new one, and only in a terminal if a destination taken out of the map may still use it.
Resend can't tell keypin which key the vault holds, so keypin never revokes the key a first rotation replaces: once
nothing uses it, delete it at Resend yourself. Later rotations wait for approval.

Each run pushes `.keypin/rotation.json`, what the next run needs to continue, and `.keypin/status.json`, each key's last
rotation for the hosted console. Neither holds a value or a vault reference. `rotation.json` holds the provider's ID
for the new and the old key, which can name a project or service account, and a short hash of each key. In a public
repository, anyone can see which keys exist and when an old one still works.
