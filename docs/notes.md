# Notes

## `wrangler dev`

`wrangler dev` gives the Worker an environment variable only when its name is in the config's `secrets.required`,
and only when there's no `.dev.vars` file. To use keypin's keys:

1. List each secret under `secrets.required` in the wrangler config.
2. Import the secrets in `.dev.vars`, then delete the file. Pass a plain setting with `wrangler dev --var
   NAME:value`, never a secret: the value would show in the process list and shell history.
3. Run `keypin run -- wrangler dev`.

## The wrangler login

keypin reads the login that `wrangler login` saves, from the same file wrangler uses:

- macOS: `~/Library/Preferences/.wrangler/config/default.toml`
- Linux: `~/.config/.wrangler/config/default.toml`, or `$XDG_CONFIG_HOME/.wrangler/...` when that's set

An older `~/.wrangler` folder wins when it exists. keypin doesn't read a login kept in the system keyring, or find
one on Windows.

## Files keypin keeps

- `~/.config/keypin/registry.json`: the registered projects
- `~/.local/state/keypin/state.json`: publish receipts

They follow `XDG_CONFIG_HOME` and `XDG_STATE_HOME`, and never hold a value.
