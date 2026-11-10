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
  <img src="https://img.shields.io/badge/status-pre--release-8A5300" alt="Pre-release">
  <img src="https://img.shields.io/badge/license-MIT-121311" alt="MIT">
  <img src="https://img.shields.io/badge/runtime-Bun-121311" alt="Bun">
</p>

Each project lists its keys in a `keypin.toml`: names, vault items and destinations, never values. keypin reads
values from 1Password only while a command runs, and writes them nowhere on disk.

## Requirements

- git, [Bun](https://bun.sh) and [Node](https://nodejs.org) 22.18+ (the installer runs on Node)
- The [1Password](https://1password.com/downloads) desktop app

keypin runs on Bun 1.4.4 or newer and refuses an older one, because Bun 1.3.12 misparses some TOML.

## Install

```sh
git clone https://github.com/caiopizzol/keypin.git ~/keypin
cd ~/keypin
bunx --package vite-plus@1.5.1 vp install
alias keypin='bunx bun@1.4.4 ~/keypin/apps/cli/src/main.ts'
```

Add the alias to your shell profile. Package scripts don't load aliases, so call
`bunx bun@1.4.4 ~/keypin/apps/cli/src/main.ts` in full there.

> [!IMPORTANT]
> Run the install command again after every `git pull`, or keypin can't find its own packages.

## Set up

1. **1Password:** in Settings → Developer, under "Integrate with the 1Password SDKs", select **Integrate with other
   apps**. 1Password then asks you to approve each keypin command.
2. **Each vault item** needs:
   - the value in its `password` field;
   - a Date field `rotated`: the day the value last changed;
   - a Text field `rotate_every`: `<n>d`, `<n>w`, `<n>m` or `never` (or set it in `keypin.toml`).
3. **Each project:**

   ```sh
   cd ~/code/my-project
   keypin init     # registers the folder and writes a commented keypin.toml
   $EDITOR keypin.toml
   keypin status   # exit 0 means no problems
   ```

## Commands

```sh
keypin init [folder]        # register a project and write a keypin.toml template
keypin unregister [folder]  # stop listing a project; its keypin.toml stays
keypin status [--json]      # every key, its rotation dates and receipts, then problems
keypin run -- <command>     # run a command with the project's dev keys in its environment
keypin publish <key-id>     # check accounts, show the plan, then write the key to every destination
```

`publish` writes `prod` by default (`--env dev` for dev). It checks each destination is the account the map pins,
skips destinations that already have this value, and asks you to type `yes` before a first write or an account
change. `--yes` never gives that approval.

Destinations: GitHub Actions secrets (with `gh`'s login) and Cloudflare Worker secrets (with wrangler's login).

## Notes

- **Cloudflare Workers:** `wrangler dev` passes environment variables to the Worker only for names in
  `secrets.required`, and a `.dev.vars` file overrides them. Delete `.dev.vars`, then `keypin run -- wrangler dev`.
- **macOS only for now:** the Cloudflare destination reads wrangler's login from its macOS path.
- **Files on your machine:** the project registry (`~/.config/keypin/registry.json`) and receipts
  (`~/.local/state/keypin/state.json`). Both honor `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.

## Development

```sh
bun run check      # format, lint and type-check
bun run test       # tests
bun run typecheck  # tsc in every package
```

Install with the command above, never a plain `bun install`: Bun 1.3 rewrites `bun.lock` in an older format.
