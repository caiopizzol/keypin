# Scheduled rotation

A GitHub Actions workflow in your repository can rotate keys on a schedule. It runs on your runners, never on a
keypin server. keypin creates each new key, saves it to your vault and publishes it, then stops: the old key keeps
working until a person approves deleting it. The setup below is for keys kept in 1Password and published to GitHub
Actions; for another vault, see [Other vaults](#other-vaults).

## Setup

1. Move each key and its issuer's `admin` item into a vault you create, and point `[providers]` and each `admin`
   reference in `secretspec.toml` at it. A [service account](service-accounts.md) can't open the Private, Personal or
   Employee vaults, or the default Shared vault. `rotate --due` skips a key without `rotate_every` or a `rotated`
   date on its item.
2. Create a service account with write access to that vault, and save its token as the Actions secret
   `OP_SERVICE_ACCOUNT_TOKEN`. keypin reads each admin key from the vault, so it isn't a secret of its own.
3. Create a fine-grained GitHub token for this repository only, with the Secrets permission set to Read and write,
   and save it as the Actions secret `KEYPIN_GITHUB_TOKEN`. Keys published to an environment also need Environments
   set to Read and write. The workflow's own `GITHUB_TOKEN` can't write secrets.
4. Add the workflow below as `.github/workflows/rotate-keys.yml`. Every run, manual ones too, reads and pushes
   `.keypin/` on the default branch, so the workflow must be allowed to push to it. Pin the keypin version you run on
   your laptop, and bump both together. It checks every day at 06:17 UTC, so a due key usually rotates that day,
   though GitHub can delay or skip a scheduled run. To check at other times, change the
   [schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule);
   add `timezone:` to use your own time zone.
5. [Ignore](../reference/secretspec-toml.md#toolkeypin) the two secrets in `secretspec.toml`, or `keypin check` asks
   you to add them:

   ```toml
   [tool.keypin]
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
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.repository.default_branch }}
      - run: npm install -g keypin@0.40.0 # x-release-please-version
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

## Other vaults

With Infisical or AWS Secrets Manager, the job signs in to the vault with GitHub Actions OIDC, so the repo stores no
vault token. Set up the identity or role on the vault's page
([Infisical](../integrations/vaults/infisical.md#signing-in-from-github-actions),
[AWS Secrets Manager](../integrations/vaults/aws-secrets-manager.md#signing-in-from-github-actions)), with write
access to the keys and their admin keys. In the workflow, add `id-token: write` under `permissions`, and set
`KEYPIN_INFISICAL_IDENTITY_ID` or `KEYPIN_AWS_ROLE_ARN` in place of `KEYPIN_1PASSWORD` and
`OP_SERVICE_ACCOUNT_TOKEN`, which then needn't be ignored. With Bitwarden Secrets Manager, save `BWS_ACCESS_TOKEN` as
an Actions secret, set it in their place, and ignore it instead.

Doppler keeps no rotated date, so `rotate --due` never rotates a Doppler key, and `--check` fails for one with a
`rotate_every`. [`rotate_every`](../reference/secretspec-toml.md#toolkeypin) applies to the key name in every
profile, so set it to `"never"` or remove it wherever it's set, which stops scheduled rotation in every profile, or
keep the key in a vault that keeps dates. Rotate it by hand with `keypin rotate <KEY> --profile <name>`. A job can
still sign in to Doppler with [OIDC](../integrations/vaults/doppler.md#signing-in-from-github-actions) to publish.

## Runs

`rotate --due` rotates each key that is due and has an `issuer`, and says why it skips the others.
Without a terminal, `--yes` approves only routine writes, as in [publishing](publishing.md#steps).

When an old key waits for approval, the run passes with a warning; a red run means something failed. To approve, run
the workflow with **approve revoke** checked, and a key to approve only that one. keypin deletes an old key only if
every destination got the new one, and only in a terminal if a destination taken out of `secretspec.toml` may still use it.
Resend can't tell keypin which key the vault holds, so keypin never revokes the key a first rotation replaces: once
nothing uses it, delete it at Resend yourself. Later rotations wait for approval.

Each run pushes `.keypin/rotation.json`, what the next run needs to continue, and `.keypin/status.json`, each key's last
rotation for the hosted console. Neither holds a value or a vault reference. `rotation.json` holds the provider's ID
for the new and the old key, which can name a project or service account, and a short hash of each key. In a public
repository, anyone can see which keys exist and when an old one still works.
