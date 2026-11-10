<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/keypin-dark.svg">
    <img src=".github/assets/keypin.svg" width="80" height="80" alt="keypin">
  </picture>
</p>

<h1 align="center">keypin</h1>

<p align="center">
  A map of every app key across your projects, published to the account it's pinned to.
  <br>
  Values stay in your vault.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/keypin"><img src="https://img.shields.io/npm/v/keypin?color=121311" alt="npm version"></a>
  <img src="https://img.shields.io/badge/license-MIT-121311" alt="MIT">
  <img src="https://img.shields.io/badge/runtime-Bun-121311" alt="Bun">
</p>

Each project lists its keys in a `keypin.toml`: names, vault items and destinations, never values. keypin runs your
commands with dev keys, publishes keys to GitHub Actions and Cloudflare Workers, and rotates Cloudflare API tokens.
It reads values from 1Password only while a command runs, and never writes them to disk.

## Install

You need [Bun](https://bun.sh) 1.4.4 or newer and the [1Password](https://1password.com/downloads) desktop app.
Publishing to Cloudflare works on macOS only for now.

```sh
bun add -g keypin
```

In 1Password, open **Settings → Developer**. Under **Integrate with the 1Password SDKs**, select **Integrate with
other apps**. 1Password then asks you to approve each keypin command.

## Quick start

Register a project. `keypin init` writes a commented `keypin.toml` for you to fill in:

```sh
cd ~/code/my-project
keypin init
```

A key looks like this:

```toml
[vaults.personal]
kind = "1password"
account = "my.1password.com"
vault = "Private"

[keys.api-token]
env = "API_TOKEN"
owner = "my-project"

[keys.api-token.dev] # read by keypin run
vault = "personal"
item = "my-project dev api token"

[keys.api-token.prod] # read by keypin publish
vault = "personal"
item = "my-project prod api token"

[[keys.api-token.prod.publish]] # where publish writes it
to = "github-actions"
repo = "me/my-project"
```

In 1Password, each item holds the value in its `password` field, plus a `rotated` date and a `rotate_every` period
such as `90d`. Now use it:

```sh
keypin status               # every key, when it's due, and any problem
keypin run -- npm run dev   # run a command with the dev keys
keypin publish api-token    # write the prod value to the GitHub secret
```

## Commands

```sh
keypin init [folder]         # register a project and write a keypin.toml
keypin unregister [folder]   # stop listing a project (its keypin.toml stays)
keypin status [--json]       # every key, when it's due, and any problem
keypin run -- <command>      # run a command with the project's dev keys
keypin publish <key-id>      # check each destination's account, then write the key
keypin rotate <key-id>       # replace a Cloudflare API token, then revoke the old one
```

`publish` and `rotate` show a plan and wait for you to type `yes`. `--yes` skips that only for routine updates. It
never approves a first write, a changed account or vault item, or a revoke.

## Docs

- [Configuration](https://github.com/caiopizzol/keypin/blob/main/docs/configuration.md): every field in
  `keypin.toml` and in the vault items.
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md): destinations, account checks and
  approvals.
- [Rotation](https://github.com/caiopizzol/keypin/blob/main/docs/rotation.md): how `rotate` works, and the admin
  token it needs.
- [Notes](https://github.com/caiopizzol/keypin/blob/main/docs/notes.md): `wrangler dev`, and the files keypin keeps.
- [Development](https://github.com/caiopizzol/keypin/blob/main/docs/development.md): install from source, checks and
  releases.
