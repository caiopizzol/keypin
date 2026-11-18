# Scheduled rotation

A GitHub Actions workflow in your repository can rotate keys on a schedule. It runs on your runners, never on a
keypin server. keypin creates each new key, saves it to your vault and publishes it, then stops: the old key keeps
working until a person approves deleting it.

```yaml
name: rotate keys

on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
    inputs:
      approve_revoke:
        description: Revoke the old keys waiting for approval
        type: boolean
        default: false
      key:
        description: Only this key, or empty for every key that waits
        type: string

permissions:
  contents: write

concurrency: rotate-keys

jobs:
  rotate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: npm install -g keypin@0.31.0
      - run: gh auth login --hostname github.com --with-token <<< "$TOKEN"
        env:
          TOKEN: ${{ secrets.KEYPIN_GITHUB_TOKEN }}
      - run: keypin rotate ${KEY:+"$KEY"} ${{ inputs.approve_revoke && '--approve-revoke' || '--due --yes' }}
        env:
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

It needs two Actions secrets:

- `OP_SERVICE_ACCOUNT_TOKEN`: a [service account](service-account.md) with write access to the vault that holds the
  keys and each issuer's `admin` item. keypin reads the admin key from there, so it isn't a secret of its own.
- `KEYPIN_GITHUB_TOKEN`: a fine-grained token for this repository only, with the Secrets permission set to Read and
  write. The workflow's own `GITHUB_TOKEN` can't write secrets.

If your plan has environments with deployment branches, keep both secrets in an environment only the default branch can
use, and add `environment: <name>` to the job.

`rotate --due` rotates each key that is due and has an `issuer` and destinations, and says why it skips the others.
Without a terminal, `--yes` approves only routine writes, as in [publishing](publishing.md#steps). A runner starts with
no receipts, so before the first scheduled run, publish each key from your laptop, run `keypin rotate --due` there,
and commit `.keypin/`.

When an old key waits for approval, the run passes with a warning; a red run means something failed. To approve, run
the workflow with **approve revoke** checked, and a key to approve only that one. keypin deletes an old key only if
every destination got the new one, and only in a terminal if a destination taken out of the map may still use it.

Each run pushes `.keypin/rotation.json`, what the next run needs to continue, and `.keypin/status.json`, each key's last
rotation for the hosted console, so the workflow must be allowed to push to the default branch. Neither holds a value
or a vault reference. `rotation.json` holds the provider's ID for the new and the old key, which can name a project or
service account, and a short hash of each key. In a public repository, anyone can see which keys exist and when an old
one still works.
