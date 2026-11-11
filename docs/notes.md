# Notes

## `wrangler dev`

`wrangler dev` passes environment variables to the Worker only for names in its config's `secrets.required`, and a
`.dev.vars` file overrides them. To use keypin's dev keys, list the names under `secrets.required`, delete
`.dev.vars`, then run:

```sh
keypin run -- wrangler dev
```

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

keypin 0.4 and older refuse the files this version writes, with a schema version error. The path is where the
project's `keypin.toml` is now, so finish a rotation before you move a project's folder.
