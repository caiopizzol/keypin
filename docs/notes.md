# Notes

## `wrangler dev`

`wrangler dev` passes environment variables to the Worker only for names in its config's `secrets.required`, and a
`.dev.vars` file overrides them. To use keypin's dev keys, list the names under `secrets.required`, delete
`.dev.vars`, then run:

```sh
keypin run -- wrangler dev
```

## Files on your machine

| File                                   | Holds                             |
| -------------------------------------- | --------------------------------- |
| `~/.config/keypin/registry.json`       | the registered projects           |
| `~/.local/state/keypin/state.json`     | publish receipts                  |
| `~/.local/state/keypin/rotations.json` | unfinished and finished rotations |

They follow `XDG_CONFIG_HOME` and `XDG_STATE_HOME`. None of them hold a value.
