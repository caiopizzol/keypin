# Install

This page installs the keypin CLI, upgrades it, and removes it.

keypin runs on macOS, and on Linux with glibc, on arm64 or x64. It doesn't run on Windows, or on musl systems such
as Alpine.

```sh
npm install -g keypin
keypin --version
```

npm installs keypin as one executable for your platform, with its runtime inside.

keypin also needs a way into your vault, such as the 1Password desktop app, and the logins of the places it
publishes to. You don't need to set them up first: `keypin check` lists each one a project still needs.

To teach a coding agent to use keypin, add the keypin skill; see [Use with an agent](../../README.md#use-with-an-agent).

## Upgrading

```sh
npm install -g keypin@latest
```

If a workflow pins a keypin version, as [Scheduled rotation](../guides/scheduled-rotation.md) does, bump it to the
version on your laptop.

## Uninstalling

```sh
npm uninstall -g keypin
```

This leaves your projects' `keypin.toml` files, and the two files keypin keeps on your machine: the registered
projects in `~/.config/keypin/registry.json`, and publish receipts in `~/.local/state/keypin/state.json`. Delete them if you won't use keypin again. Finish any rotation first:
`state.json` holds the provider ID of each key `rotate` created. See [Files and state](../reference/files-and-state.md).

Next: [Your first project](../get-started/your-first-project.md).
