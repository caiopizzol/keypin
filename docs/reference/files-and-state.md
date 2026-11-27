# Files and state

keypin keeps these files. None of them holds a key's value.

- `~/.config/keypin/registry.json`: the projects `keypin status` lists. `check`, and a `publish` or `rotate` that
  can write, add the project the first time they run in it; `keypin unregister` removes it.
- `~/.local/state/keypin/state.json`: publish receipts, and the provider ID of each key `rotate` created.
- `.keypin/status.json` and `.keypin/rotation.json`, in a project: each key's last rotation and a scheduled
  rotation's progress, by profile. keypin writes them but never commits or pushes them. Keep them between runs: a run on
  a fresh runner, without `rotation.json`, can't find an old key that waits to be revoked. See
  [Scheduled rotation](../guides/scheduled-rotation.md#runs).

The first two follow `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.
