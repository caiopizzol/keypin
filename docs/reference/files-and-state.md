# Files and state

- `~/.config/keypin/registry.json`: the projects `keypin status` lists. `check`, and a `publish` or `rotate` that
  can write, add the project the first time they run in it; `keypin unregister` removes it.
- `~/.local/state/keypin/state.json`: publish receipts, and the provider ID of each key `rotate` created

They follow `XDG_CONFIG_HOME` and `XDG_STATE_HOME`, and never hold a value.

In a project, `.keypin/status.json` and `.keypin/rotation.json` hold each key's last rotation and a scheduled
rotation's progress, by profile. See [Scheduled rotation](../guides/scheduled-rotation.md#runs).
