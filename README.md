<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/keypin-dark.svg">
    <img src=".github/assets/keypin.svg" width="80" height="80" alt="keypin">
  </picture>
</p>

<h1 align="center">keypin</h1>

<p align="center">
  Rotate a key everywhere it's used.
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

When a key has to change, keypin replaces it at the provider and everywhere it's used, across all your projects.
`keypin rotate` makes the new key, publishes it to each destination in the project's `secretspec.toml`, and revokes
the old one only after you approve. `keypin status` shows what's due in every project.

[secretspec](https://secretspec.dev) says which keys a project needs and runs it with them. keypin keeps those keys
fresh everywhere, from settings under `[tool.keypin]` in the same file. Values stay in your vault.

| Rotation                          | Destinations       | Vaults              |
| --------------------------------- | ------------------ | ------------------- |
| Resend                            | GitHub Actions     | 1Password           |
| Neon                              | Cloudflare Workers | Infisical           |
| OpenAI                            | Vercel projects    | Bitwarden           |
| Supabase                          | Supabase Functions | Doppler             |
| Cloudflare API tokens             | Netlify projects   | AWS Secrets Manager |
| OpenRouter                        | Railway services   |                     |
| Google Cloud API keys             | Convex deployments |                     |
| ElevenLabs                        | Fly.io apps        |                     |
| AWS IAM access keys               | GitLab CI/CD       |                     |
| SendGrid                          |                    |                     |
| Twilio API keys                   |                    |                     |
| xAI                               |                    |                     |
| Google Cloud service account keys |                    |                     |
| MongoDB Atlas                     |                    |                     |
| Secrets you generate              |                    |                     |

Want another? Vote for it on the [roadmap](https://github.com/caiopizzol/keypin/issues/138).

## Install

keypin runs on macOS, and on Linux with glibc (not Alpine), on arm64 or x64. It works with
[secretspec](https://secretspec.dev/quick-start/), which you install too.

```sh
npm install -g keypin
```

## Get started

```sh
cd ~/code/my-project
secretspec init                 # declare the keys in secretspec.toml
keypin check                    # what the project uses, what's missing, and what to add
keypin publish --all            # write production keys to their destinations
keypin rotate RESEND_API_KEY    # make a new key at the provider, save it to your vault and publish it
```

[Get started](https://github.com/caiopizzol/keypin/blob/main/docs/get-started/your-first-project.md) walks through
each step. `rotate` needs the key's
[issuer](https://github.com/caiopizzol/keypin/blob/main/docs/guides/rotating-a-key.md) first. `publish` and `rotate`
show a plan and wait for you to answer `y`.

## Commands

```sh
keypin rotate <VARIABLE>                 # replace a key at its provider, then publish it
keypin rotate --due                      # rotate every key that is due
keypin status                            # every project's keys, and when each is due for rotation
keypin publish <VARIABLE> | --all        # write production keys to their destinations
keypin check [folder]                    # report one project; writes nothing
keypin unregister [folder]               # stop listing a project
```

`--profile <name>` picks another profile. `keypin <command> --help` lists every option, and `keypin --help` the exit
codes.

## Use with an agent

The keypin skill teaches a coding agent to use keypin without seeing values, and to hand each approval back to
you:

```sh
npx skills add caiopizzol/keypin       # this project
npx skills add caiopizzol/keypin -g    # all your projects
```

## Docs

- [How it works](https://github.com/caiopizzol/keypin/blob/main/docs/introduction/how-it-works.md): the provider,
  your vault, `secretspec.toml` and where keys go
- [Rotating a key](https://github.com/caiopizzol/keypin/blob/main/docs/guides/rotating-a-key.md): each issuer, and
  rotating by hand
- [Scheduled rotation](https://github.com/caiopizzol/keypin/blob/main/docs/guides/scheduled-rotation.md): rotating
  keys in your GitHub Actions
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/guides/publishing.md): destinations, approvals,
  `--plan` and reading keys in CI
- [secretspec.toml](https://github.com/caiopizzol/keypin/blob/main/docs/reference/secretspec-toml.md): profiles,
  providers and `[tool.keypin]`
- [Vaults](https://github.com/caiopizzol/keypin/blob/main/docs/README.md#vaults): each vault's provider, sign-in and
  rotated date
- [Troubleshooting](https://github.com/caiopizzol/keypin/blob/main/docs/reference/troubleshooting.md): `wrangler dev`
  and signing in to Cloudflare
- [API keys](https://keypin.dev/keys): where to get each key, how to set it and how to replace it
- [All docs](https://github.com/caiopizzol/keypin/blob/main/docs/README.md), and
  [Development](https://github.com/caiopizzol/keypin/blob/main/docs/development.md) for working on keypin
