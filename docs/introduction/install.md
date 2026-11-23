# Install

keypin runs on macOS, and on Linux with glibc, on arm64 or x64.

```sh
npm install -g keypin
```

`keypin check` lists the vault app and logins each project still needs, so you don't set them up first. To use
keypin with a coding agent, add the [keypin skill](../../README.md#use-with-an-agent).

To upgrade, run `npm install -g keypin@latest`. If a workflow pins a version, as
[Scheduled rotation](../guides/scheduled-rotation.md) does, bump it too.

To uninstall, run `npm uninstall -g keypin`. Your `keypin.toml` files and keypin's
[own files](../reference/files-and-state.md) stay.
