<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/keypin-dark.svg">
    <img src=".github/assets/keypin.svg" width="80" height="80" alt="keypin">
  </picture>
</p>

<h1 align="center">keypin</h1>

<p align="center">
  Key syncs and rotation for the vault you already use.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/keypin"><img src="https://img.shields.io/npm/v/keypin?color=121311" alt="npm version"></a>
  <img src="https://img.shields.io/badge/license-MIT-121311" alt="MIT">
  <br />
  <a href="https://keypin.dev">keypin.dev</a> · <a href="#docs">Docs</a> ·
  <a href="https://keypin.dev/console/">Console</a> · <a href="https://keypin.dev/keys">API keys</a>
</p>

> **The keypin CLI is free and open source.** No account, no server, and it never stores a value.

## What is keypin?

keypin is not a vault. It reads the one you already have, runs your apps with its keys, publishes them to CI and
hosting, and rotates them. Nothing to commit, paste in a chat, or leave on a laptop.

Each project lists its keys in a `keypin.toml`: names, vault items and destinations, never values. keypin reads a
value only while a command runs.

| Vaults              | Destinations       | Rotation                          |
| ------------------- | ------------------ | --------------------------------- |
| 1Password           | GitHub Actions     | Resend                            |
| Infisical           | Cloudflare Workers | Neon                              |
| Bitwarden           | Vercel projects    | OpenAI                            |
| Doppler             | Supabase Functions | Supabase                          |
| AWS Secrets Manager | Netlify projects   | Cloudflare API tokens             |
|                     | Railway services   | OpenRouter                        |
|                     | Convex deployments | Google Cloud API keys             |
|                     | Fly.io apps        | ElevenLabs                        |
|                     | GitLab CI/CD       | AWS IAM access keys               |
|                     |                    | SendGrid                          |
|                     |                    | Twilio API keys                   |
|                     |                    | xAI                               |
|                     |                    | Google Cloud service account keys |
|                     |                    | MongoDB Atlas                     |
|                     |                    | Secrets you generate              |

Want another? Vote for it on the [roadmap](https://github.com/caiopizzol/keypin/issues/138).

## Install

keypin runs on macOS, and on Linux with glibc (not Alpine), on arm64 or x64.

```sh
npm install -g keypin
```

## Get started

```sh
cd ~/code/my-project
keypin init                     # write keypin.toml
keypin check                    # what the project uses, what's missing, and what to run or add
keypin import .env STRIPE_KEY --vault Private --account my.1password.com
                                # move a key into 1Password; it says which .env lines to remove
keypin run -- npm run dev       # run your app with the keys from your vault
```

[Get started](https://github.com/caiopizzol/keypin/blob/main/docs/get-started/your-first-project.md) walks through
each step, then publishing your production keys.

## Commands

```sh
keypin init [folder]                     # write keypin.toml and register the project
keypin check [folder]                    # report one project; writes nothing
keypin import <env-file> [NAME...] [--profile <name>] --vault <vault>
                                         # move an env file's values into 1Password and map them
keypin run [--only NAME] -- <command>    # run a command with the dev keys, or only the named ones
keypin publish <VARIABLE> | --all        # write prod keys to their destinations
keypin rotate <VARIABLE>                 # replace a key at its provider, then publish it
keypin status                            # every project's keys, and when each is due for rotation
keypin unregister [folder]               # stop listing a project
```

`keypin <command> --help` lists every option, and `keypin --help` the exit codes.

## Use with an agent

The keypin skill teaches a coding agent to use keypin without seeing values, and to hand each approval back to
you:

```sh
npx skills add caiopizzol/keypin       # this project
npx skills add caiopizzol/keypin -g    # all your projects
```

## Docs

- [How it works](https://github.com/caiopizzol/keypin/blob/main/docs/introduction/how-it-works.md): the vault, the
  map and where keys go
- [keypin.toml](https://github.com/caiopizzol/keypin/blob/main/docs/reference/secretspec-toml.md): keys, environments and vault
  items
- [Moving off env files](https://github.com/caiopizzol/keypin/blob/main/docs/guides/moving-off-env-files.md): moving an env file's values into 1Password
- [Infisical](https://github.com/caiopizzol/keypin/blob/main/docs/integrations/vaults/infisical.md),
  [Bitwarden](https://github.com/caiopizzol/keypin/blob/main/docs/integrations/vaults/bitwarden.md),
  [Doppler](https://github.com/caiopizzol/keypin/blob/main/docs/integrations/vaults/doppler.md) and
  [AWS Secrets Manager](https://github.com/caiopizzol/keypin/blob/main/docs/integrations/vaults/aws-secrets-manager.md): reading keys
  from them instead
- [Service accounts](https://github.com/caiopizzol/keypin/blob/main/docs/guides/service-accounts.md): 1Password on a server or
  in CI
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/guides/publishing.md): destinations, approvals,
  `--plan` and pulling in CI
- [Rotating a key](https://github.com/caiopizzol/keypin/blob/main/docs/guides/rotating-a-key.md): each issuer, and rotating by hand
- [Scheduled rotation](https://github.com/caiopizzol/keypin/blob/main/docs/guides/scheduled-rotation.md): rotating 1Password
  keys in your GitHub Actions
- [Troubleshooting](https://github.com/caiopizzol/keypin/blob/main/docs/reference/troubleshooting.md): `wrangler dev` and signing in
  to Cloudflare
- [Files and state](https://github.com/caiopizzol/keypin/blob/main/docs/reference/files-and-state.md): the files keypin keeps
- [API keys](https://keypin.dev/keys): where to get each key, how to set it and how to replace it
- [Development](https://github.com/caiopizzol/keypin/blob/main/docs/development.md): working on keypin
