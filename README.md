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
keypin init    # write keypin.toml
keypin check   # what the project uses, what's missing, and what to run or add
```

`check` starts with the logins and apps you still need to set up, if any.

### Local keys

Move the secrets from your `.env` into 1Password, then run your app with them:

```sh
keypin import .env STRIPE_KEY DATABASE_URL --vault Private --account my.1password.com
keypin run -- npm run dev
```

`import` creates one item per variable and maps it. Variables you don't name, such as `PORT`, stay in the file. See
[Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md).

### Production keys

Put each prod value in 1Password first:

- **In a file:** `keypin import .env.production STRIPE_KEY --env prod --vault Private`
- **Only in GitHub or Cloudflare:** neither keypin nor you can read it back, so make a new key at the provider.

Then `keypin check` prints the TOML to add for each secret a workflow or Worker needs:

```toml
[[keys.STRIPE_KEY.prod.publish]]
to = "github-actions"
repo = "me/my-project"
```

Paste it into `keypin.toml` and replace each `<...>`. For a key you didn't import, `from` takes its reference: in
1Password, open the field's menu and select **Copy Secret Reference**.

Then publish:

```sh
keypin publish --all
```

`publish` shows what it will write where and waits for you to answer `y`.

A GitHub Actions job can instead read a key from your vault at job time, so no copy is stored. With AWS Secrets
Manager it signs in with OIDC. See [Pulling in CI](https://github.com/caiopizzol/keypin/blob/main/docs/configuration.md#pulling-in-ci).

To rotate a key, give it an
[issuer](https://github.com/caiopizzol/keypin/blob/main/docs/configuration.md#rotating-a-key) and run `keypin rotate
RESEND_API_KEY`. keypin creates the new key, saves and publishes it, and asks before it revokes the old one.

## Commands

```sh
keypin init [folder]                     # write keypin.toml and register the project
keypin check [folder]                    # report one project; writes nothing
keypin import <env-file> [NAME...] [--env <name>] --vault <vault>
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

- [Configuration](https://github.com/caiopizzol/keypin/blob/main/docs/configuration.md): every field in
  `keypin.toml`
- [Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md): moving an env file's values into 1Password
- [Infisical](https://github.com/caiopizzol/keypin/blob/main/docs/infisical.md),
  [Bitwarden](https://github.com/caiopizzol/keypin/blob/main/docs/bitwarden.md),
  [Doppler](https://github.com/caiopizzol/keypin/blob/main/docs/doppler.md) and
  [AWS Secrets Manager](https://github.com/caiopizzol/keypin/blob/main/docs/aws-secrets-manager.md): reading keys
  from them instead
- [Service account](https://github.com/caiopizzol/keypin/blob/main/docs/service-account.md): 1Password on a server or
  in CI
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md): destinations, approvals and
  `--plan`
- [Scheduled rotation](https://github.com/caiopizzol/keypin/blob/main/docs/scheduled-rotation.md): rotating 1Password
  keys in your GitHub Actions
- [Notes](https://github.com/caiopizzol/keypin/blob/main/docs/notes.md): `wrangler dev`, signing in to Cloudflare, and
  the files keypin keeps
- [API keys](https://keypin.dev/keys): where to get each key, how to set it and how to replace it
- [Development](https://github.com/caiopizzol/keypin/blob/main/docs/development.md): working on keypin
