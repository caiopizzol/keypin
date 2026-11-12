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
commands with dev keys, publishes keys to GitHub Actions and Cloudflare Workers, and reminds you when a key is due
for rotation. It reads values from 1Password only while a command runs, and never writes them to disk.

## Install

You need [Bun](https://bun.sh) 1.4.4 or newer and the [1Password](https://1password.com/downloads) desktop app.
To publish, you also need a [`gh`](https://cli.github.com) login for GitHub, or a
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/) login for Cloudflare (macOS or Linux).

```sh
bun add -g keypin
```

In 1Password, open **Settings → Developer**. Under **Integrate with the 1Password SDKs**, select **Integrate with
other apps**. 1Password then asks you to approve each keypin command.

## Use with an agent

The keypin skill tells a coding agent how to use keypin: keep values out of chat and files, and hand each approval
back to you. It works with Claude Code, Codex, Cursor and other agents that read skills.

```sh
npx skills add caiopizzol/keypin       # this project
npx skills add caiopizzol/keypin -g    # all your projects
```

## Quick start

Register a project. `keypin init` writes a commented `keypin.toml` for you to fill in:

```sh
cd ~/code/my-project
keypin init
```

A key looks like this:

```toml
[1password]
account = "my.1password.com"

[keys.API_TOKEN] # the variable your program reads
rotate_every = "90d"
dev = "op://Private/my-project dev api token/credential" # read by keypin run

[keys.API_TOKEN.prod] # read by keypin publish
from = "op://Private/my-project prod api token/credential"

[[keys.API_TOKEN.prod.publish]] # where publish writes it
to = "github-actions"
repo = "me/my-project"
```

Each `op://` reference is a 1Password secret reference: in the item, open the field's menu and select **Copy Secret
Reference**. Add a `rotated` date to the item. Now use it:

```sh
keypin status               # every key, when it's due, and any problem
keypin run -- npm run dev   # run a command with the dev keys
keypin publish API_TOKEN    # write the prod value to the GitHub secret
```

### Coming from a .env

`keypin import` moves a `.env` file's values into new 1Password items and maps them:

```sh
keypin import .env --vault Private --account my.1password.com
```

It shows each item it will create and waits for you to type `yes`. It never overwrites an item, and it never changes
the `.env` file. It names any variable it left only in the file; move those, then delete the file yourself, and
`keypin run -- <command>` provides the values.
See [Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md).

## Commands

```sh
keypin init [folder]         # register a project and write a keypin.toml
keypin unregister [folder]   # stop listing a project (its keypin.toml stays)
keypin status [--json]       # every key, when it's due, and any problem
keypin check [folder]        # check the map, vault items and logins, and write nothing
keypin discover [folder]     # every key name a project uses, where it's set, and a draft map
                             # (--write saves the draft as keypin.toml and registers the project)
keypin import <env-file> --vault <vault>
                             # move an env file's values into 1Password and map them
keypin run -- <command>      # run a command with the project's dev keys (--env for another)
keypin publish <VARIABLE>    # check each destination's account, then write the key
keypin publish --all         # publish every key, with one plan and one approval
keypin publish --all --plan  # show that plan without a terminal, and write nothing
```

### Check a setup

`keypin check` checks a project before you publish, and changes nothing:

- the map parses;
- each `op://` reference's item and field exist;
- for each destination, the login keypin would use, who it acts as, the account it reaches, and how to fix a
  mismatch.

It reads each value to check its field, so 1Password asks you to approve it, and it never prints a value. It
also notes a login stored in plain text, such as wrangler's. It exits 0 when everything checks out, and 1 with
one line per problem. `--json` prints the same as JSON.

Add `--plan` to `publish` to see the plan without a terminal. It changes nothing, and prints the command that
does.

`import` and `publish` show a plan and wait for you to type `yes`. `--yes` approves `import`, which only creates
new items. For `publish`, it skips that only for routine updates: it never approves a first write, or a changed
account or vault item. `keypin --help` lists the exit codes.

### Rotate a key

`keypin status` shows when each key is due, from its `rotate_every` and its item's `rotated` date. To rotate one,
make a new value where the key comes from (the provider's dashboard, for example), paste it into the 1Password
field, set `rotated` to today, then run `keypin publish <VARIABLE>`. Revoke the old value once everything uses the
new one.

## Docs

- [Configuration](https://github.com/caiopizzol/keypin/blob/main/docs/configuration.md): every field in
  `keypin.toml` and in the vault items.
- [Discover](https://github.com/caiopizzol/keypin/blob/main/docs/discover.md): what `discover` reads, the problems
  it reports, and its draft map.
- [Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md): moving a `.env` file's values into
  1Password.
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md): destinations, account checks and
  approvals.
- [Notes](https://github.com/caiopizzol/keypin/blob/main/docs/notes.md): `wrangler dev`, and the files keypin keeps.
- [Development](https://github.com/caiopizzol/keypin/blob/main/docs/development.md): install from source, checks and
  releases.
