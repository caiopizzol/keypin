# Notes

## `wrangler dev`

`wrangler dev` passes environment variables to the Worker only for names in its config's `secrets.required`, and
only when there's no `.dev.vars` file: while one exists, it reads secrets from that file alone. To use keypin's dev
keys, list the names under `secrets.required`, import any secret still in `.dev.vars`, and delete it. A plain
setting that isn't secret can go to `wrangler dev --var NAME:value`, which puts the value on the command line, so
never use it for a secret. Top-level `[vars]` in the wrangler config deploy with the Worker. Then run:

```sh
keypin run -- wrangler dev
```

`keypin run` warns, before it starts the command, when an env file in the project folder or the current folder still
holds a key it provides. It names the file and the keys, never a value, and still starts the command. For
`.dev.vars`, `wrangler dev` uses the file's value over keypin's. For `.env` files, which value wins depends on the
tool, but the file still holds a plaintext copy.

## The wrangler login

To publish to Cloudflare, keypin reads the OAuth login `wrangler login` saves, in the same file wrangler uses:

| Platform | File                                                  |
| -------- | ----------------------------------------------------- |
| macOS    | `~/Library/Preferences/.wrangler/config/default.toml` |
| Linux    | `~/.config/.wrangler/config/default.toml`             |

When `XDG_CONFIG_HOME` is set, the folder is `$XDG_CONFIG_HOME/.wrangler` on both. When a `~/.wrangler` folder
exists, from an older wrangler, it wins over both, as it does for wrangler. keypin doesn't read a login wrangler
keeps in the system keyring (`CLOUDFLARE_AUTH_USE_KEYRING`), and it doesn't find the login on Windows yet.

## Files on your machine

| File                               | Holds                                              |
| ---------------------------------- | -------------------------------------------------- |
| `~/.config/keypin/registry.json`   | the registered projects                            |
| `~/.local/state/keypin/state.json` | publish receipts, and publishes that didn't finish |

They follow `XDG_CONFIG_HOME` and `XDG_STATE_HOME`. None of them hold a value.

keypin versions with `keypin rotate` also kept `~/.local/state/keypin/rotations.json`. This keypin doesn't have
`rotate` and ignores that file, so an unfinished rotation isn't shown or picked up. keypin doesn't delete the
file; delete it yourself once you've finished any rotation it lists. A rotation that created a new Cloudflare token
and didn't revoke the old one leaves the old token active: delete it in the Cloudflare dashboard once nothing uses
it.

Every receipt and unfinished publish records the path of the `keypin.toml` it came from, so two projects that
both have `API_TOKEN` in `prod` keep theirs apart. keypin still finds a destination's last receipt whichever
project wrote it, so it notices when one project overwrites another's secret.

Files that keypin 0.4 or older wrote (`state.json` version 1 or 2) load, but their entries name no project, so
none counts as a project's own:

- A receipt still tells `publish` and `status` what a destination last got when it records the same vault item. A
  version 1 receipt doesn't record its item, so the next `publish` to that destination asks for approval once.
- An unfinished publish isn't shown, and `publish` plans from the receipts anyway.

A `state.json` version 3 file, from keypin 0.5 or 0.6, loads too. Its receipts record no 1Password item IDs, so
`publish` compares their references until the next write records the IDs (see
[Publishing](publishing.md#what-happens)).

keypin 0.6 and older refuse the files this version writes, with a schema version error.
