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

permissions:
  contents: write

concurrency: rotate-keys

jobs:
  rotate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: npm install -g keypin
      - run: gh auth login --hostname github.com --with-token <<< "$TOKEN"
        env:
          TOKEN: ${{ secrets.KEYPIN_GITHUB_TOKEN }}
      - run: keypin rotate ${{ inputs.approve_revoke && '--approve-revoke' || '--due --yes' }}
        env:
          KEYPIN_1PASSWORD: service-account
          OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
      - if: always()
        run: |
          git add .keypin
          git diff --cached --quiet && exit 0
          git -c user.name=keypin -c user.email=keypin@users.noreply.github.com commit -m "chore: record key rotation"
          git push
```

It needs two Actions secrets:

- `OP_SERVICE_ACCOUNT_TOKEN`: a [service account](service-account.md) with write access to the vault that holds the
  keys and each issuer's `admin` item. keypin reads the admin key from there, so it isn't a secret of its own.
- `KEYPIN_GITHUB_TOKEN`: a token that can write the repository's Actions secrets. The workflow's own `GITHUB_TOKEN`
  can't. Use a classic token with the `repo`, `read:org` and `gist` scopes.

`rotate --due` rotates each key that is due and has an `issuer` and destinations, and says why it skips the others.
Without a terminal, `--yes` approves only routine writes, as in [publishing](publishing.md#steps). A runner starts with
no receipts, so before the first scheduled run, publish each key from your laptop, run `keypin rotate --due` there,
and commit `.keypin/`.

The run exits 3 when an old key waits for approval. To approve, run the workflow with **approve revoke** checked.
keypin deletes an old key only if every destination got the new one.

Each run commits `.keypin/rotation.json`, what the next run needs to continue, and `.keypin/status.json`, each key's
last rotation for the hosted console. Neither holds a value, a vault reference or an account.
