# keypin docs

## Introduction

- [What keypin is](introduction/what-keypin-is.md)
- [How it works](introduction/how-it-works.md)
- [Install](introduction/install.md)

## Get started

- [Your first project](get-started/your-first-project.md)
- [Run your app locally](get-started/run-your-app-locally.md)
- [Ship to production](get-started/ship-to-production.md)

## Guides

Each guide is one job.

### Rotate a key

Make a new key at the provider, publish it to every destination and revoke the old one.

- [Rotating a key](guides/rotating-a-key.md)

### A key may have leaked

Rotate it now, as [Rotating a key](guides/rotating-a-key.md) says. The [console](https://keypin.dev/console/) shows
what the key reaches before you do.

### Rotate on a schedule

Rotate every key that is due in your own GitHub Actions, with approval before the old key is revoked.

- [Scheduled rotation](guides/scheduled-rotation.md)
- [Service accounts](guides/service-accounts.md)

### See every key across projects

`keypin status` lists every project's keys and when each is due. The [console](https://keypin.dev/console/) shows
what's overdue in each repo you share, and what to rotate next.

### Publish a key

Write a key from your vault to CI and hosting, or move it there from a `.env` file first.

- [Publishing](guides/publishing.md)
- [Moving off env files](guides/moving-off-env-files.md)

## Integrations

### Vaults

- [1Password](integrations/vaults/1password.md)
- [Infisical](integrations/vaults/infisical.md)
- [Bitwarden](integrations/vaults/bitwarden.md)
- [Doppler](integrations/vaults/doppler.md)
- [AWS Secrets Manager](integrations/vaults/aws-secrets-manager.md)

## Reference

- [secretspec.toml](reference/secretspec-toml.md)
- [Troubleshooting](reference/troubleshooting.md)
- [Files and state](reference/files-and-state.md)
