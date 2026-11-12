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

Each project lists its keys in a `keypin.toml`: names, vault items and destinations, never values. keypin runs your
commands with dev keys, publishes keys to GitHub Actions and Cloudflare Workers, and reminds you when a key is due
for rotation. It reads values from 1Password only while a command runs, and never writes them to disk.

## Install

keypin runs on macOS and Linux, on arm64 or x64. You need the [1Password](https://1password.com/downloads) desktop
app. To publish, you also need a [`gh`](https://cli.github.com) login for GitHub, or a
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/) login for Cloudflare.

```sh
npm install -g keypin
```

keypin is one executable with its runtime built in, so you don't need Bun. `bun add -g keypin` works too. The
package manager installs the build for your platform as an optional dependency, so don't install with
`--omit=optional` or `--no-optional`.

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

Register a project, then ask keypin what it uses:

```sh
cd ~/code/my-project
keypin init    # write a commented keypin.toml and register the project
keypin check   # every key the project uses, what's missing, and the TOML to add
```

`keypin check` reads the project's env files, its workflows and wrangler configs, and the secret names its GitHub
repo and Worker hold. It never prints a value. Each problem is one line that says what to run or add.

### Local: from a .env to keypin run

`keypin import` moves a `.env` file's keys into new 1Password items and maps them. Name the keys, and plain
settings such as `PORT` stay in the file:

```sh
keypin import .env STRIPE_KEY DATABASE_URL --vault Private --account my.1password.com
```

Without names, it imports every variable. It shows each item it will create and waits for you to type `yes`. It
never overwrites an item, and it never changes the `.env` file: it tells you which lines to remove from it. Then run
your commands with the dev keys:

```sh
keypin run -- npm run dev
```

See [Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md).

### Production: from check to keypin publish

For every secret a workflow uses or a Worker's `secrets.required` lists that `keypin.toml` doesn't publish there,
`keypin check` prints the TOML to add. It fills in what it knows: the repo from the git `origin`, and the Worker
and its account from the wrangler config.

```toml
[keys.STRIPE_API_KEY] # the variable your program reads
rotate_every = "90d"

[keys.STRIPE_API_KEY.prod] # read by keypin publish
from = "op://<vault>/<item>/<field>"

[[keys.STRIPE_API_KEY.prod.publish]] # where publish writes it
to = "github-actions"
repo = "me/my-project"
```

Paste it into `keypin.toml` and replace each `<...>`; keypin rejects a map that still has one. The `from` value is
a 1Password secret reference: create the item, open the field's menu and select **Copy Secret Reference**. Add a
`rotated` date to the item. Then:

```sh
keypin check                 # each item exists, and each login reaches the pinned account
keypin publish --all         # write every prod key, with one plan and one approval
keypin status                # every project's keys, when each is due, and any problem
```

## Commands

```sh
keypin init [folder]         # register a project and write a keypin.toml
keypin unregister [folder]   # stop listing a project (its keypin.toml stays)
keypin check [folder]        # one project: what it uses, what's missing, and the TOML to add
keypin status [--json]       # every registered project's keys, when each is due, and any problem
keypin import <env-file> [NAME...] --vault <vault>
                             # move an env file's values into 1Password and map them
keypin run -- <command>      # run a command with the project's dev keys (--env for another)
keypin publish <VARIABLE>    # check each destination's account, then write the key
keypin publish --all         # publish every key, with one plan and one approval
keypin publish --all --plan  # show that plan without a terminal, and write nothing
```

### Check a project

`keypin check` reports one project and changes nothing. It works without a map, and on the untouched `init`
template, so it's the first command after `init`. It reports:

- **The map:** it parses, and each `op://` reference's item exists.
- **Logins:** for each destination, the login keypin would use, who it acts as, the account it reaches, and how to
  fix a mismatch. It notes a login stored in plain text, such as wrangler's.
- **Production:** each secret a workflow references (`secrets.NAME`) or a wrangler config lists under
  `secrets.required`, whether the repo or Worker has it, and whether `keypin.toml` publishes it there. For each
  one the map doesn't publish there, it prints the TOML to add, with `<...>` for what it can't know.
- **Local:** each name an env file (`.env*`, `.dev.vars*`) sets that `keypin.toml` doesn't map, as a note with
  the `keypin import` command (a plain setting can stay), each one the map has only in another environment, and
  any env file tracked by git.

It checks that each item exists from its vault's item list, which holds no values, so it never reads a value. It
doesn't check the field inside the item: `keypin run` and `keypin publish --plan` read it. Listing items still signs
in to 1Password, so 1Password asks you to approve the command when the map has keys; with no keys, check doesn't
use 1Password at all. It reads the repo's and Worker's secret names with your `gh` and `wrangler` logins. A read it
can't make is listed as unknown, never as missing. It exits 1 with one line per problem, and 0 when there's
nothing to fix; anything under unknown is still unverified. `--json` prints the same as JSON.

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
- [Import](https://github.com/caiopizzol/keypin/blob/main/docs/import.md): moving a `.env` file's values into
  1Password.
- [Publishing](https://github.com/caiopizzol/keypin/blob/main/docs/publishing.md): destinations, account checks and
  approvals.
- [Notes](https://github.com/caiopizzol/keypin/blob/main/docs/notes.md): `wrangler dev`, and the files keypin keeps.
- [Development](https://github.com/caiopizzol/keypin/blob/main/docs/development.md): install from source, checks and
  releases.
