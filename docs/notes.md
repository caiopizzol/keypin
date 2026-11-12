# Notes

## `wrangler dev`

`wrangler dev` passes environment variables to the Worker only for names in its config's `secrets.required`, and
only when there's no `.dev.vars` file: while one exists, it reads secrets from that file alone. To use keypin's dev
keys, list the names under `secrets.required`, move any plain setting from `.dev.vars` to `[vars]` in the wrangler
config, delete `.dev.vars`, then run:

```sh
keypin run -- wrangler dev
```

`keypin run` warns, before it starts the command, when an env file in the project folder or the current folder still
holds a key it provides. It names the file and the keys, never a value, and still starts the command. For
`.dev.vars`, `wrangler dev` uses the file's value over keypin's. For `.env` files, which value wins depends on the
tool, but the file still holds a plaintext copy.

## Files on your machine

| File                                   | Holds                                              |
| -------------------------------------- | -------------------------------------------------- |
| `~/.config/keypin/registry.json`       | the registered projects                            |
| `~/.local/state/keypin/state.json`     | publish receipts, and publishes that didn't finish |
| `~/.local/state/keypin/rotations.json` | unfinished and finished rotations                  |

They follow `XDG_CONFIG_HOME` and `XDG_STATE_HOME`. None of them hold a value.

Every receipt, unfinished publish and rotation records the path of the `keypin.toml` it came from, so two projects
that both have `API_TOKEN` in `prod` keep theirs apart. keypin still finds a destination's last receipt whichever
project wrote it, so it notices when one project overwrites another's secret.

Files that keypin 0.4 or older wrote (`state.json` version 1 or 2, `rotations.json` version 1) load, but their
entries name no project, so none counts as a project's own:

- A receipt still tells `publish` and `status` what a destination last got when it records the same vault item. A
  version 1 receipt doesn't record its item, so the next `publish` to that destination asks for approval once.
- An unfinished publish isn't shown, and `publish` plans from the receipts anyway.
- An unfinished rotation isn't picked up or shown. Finish it with the keypin that started it before upgrading.

A `state.json` version 3 file, from keypin 0.5 or 0.6, loads too. Its receipts record no 1Password item IDs, so
`publish` compares their references until the next write records the IDs (see
[Publishing](publishing.md#what-happens)).

keypin 0.6 and older refuse the files this version writes, with a schema version error. The path is where the
project's `keypin.toml` is now, so finish a rotation before you move a project's folder.
