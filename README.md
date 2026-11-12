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
</p>

Each project lists its keys in a `keypin.toml`: names, 1Password items and destinations, never values. keypin runs
your commands with the dev keys and publishes the prod keys to GitHub Actions and Cloudflare Workers. It reads
values from 1Password only while a command runs.

## Install

keypin runs on macOS, and on Linux with glibc (not Alpine), on arm64 or x64. You need the
[1Password](https://1password.com/downloads) desktop app.

```sh
npm install -g keypin
```

Don't install with `--omit=optional`: the build for your platform is an optional dependency.

In 1Password, open **Settings → Developer** and, under **Integrate with the 1Password SDKs**, select **Integrate
with other apps**. 1Password then asks you to approve each keypin command.

To publish, you also need a [`gh`](https://cli.github.com) login for GitHub, or a
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/) login for Cloudflare.

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

`import` creates one item per variable and maps it. Variables you don't name, such as `PORT`, stay in the file.
It never changes the file: it tells you which lines to remove. See
[Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md).

### Production keys

Put each prod value in 1Password first:

- **In a file:** `keypin import .env.production STRIPE_KEY --env prod --vault Private`
- **Only in GitHub or Cloudflare:** neither keypin nor you can read it back, so make a new key at the provider.

For staging, add it to `environments` first (`check` prints the line), then import with `--env staging`.

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

`publish` shows what it will write where and waits for you to type `yes`. See
[Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md).

## Commands

```sh
keypin init [folder]                     # write keypin.toml and register the project
keypin check [folder]                    # report one project; writes nothing
keypin import <env-file> [NAME...] [--env <name>] --vault <vault>
                                         # move an env file's values into 1Password and map them
keypin run [--only NAME] -- <command>    # run a command with the dev keys, or only the named ones
keypin publish <VARIABLE> | --all        # write prod keys to their destinations
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
  `keypin.toml`, and how to rotate a key
- [Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md): moving an env file's values into 1Password
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md): destinations, approvals and
  `--plan`
- [Notes](https://github.com/caiopizzol/keypin/blob/main/docs/notes.md): `wrangler dev`, the wrangler login, and the
  files keypin keeps
- [Development](https://github.com/caiopizzol/keypin/blob/main/docs/development.md): working on keypin
