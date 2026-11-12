---
name: run-friction-round
description: Have subagents use keypin through its skill in a sandbox where 1Password, GitHub and Cloudflare are fakes, and report each friction with evidence. Use before or after a change to the CLI's commands or output, or to skills/keypin/SKILL.md, or when asked how keypin works for an agent or a new user.
metadata:
  internal: "true"
---

# Run a friction round

A friction round puts a subagent in the user's project with only [the keypin skill](../../../skills/keypin/SKILL.md) and a task, and watches what it does. `docs/agent-frictions.md` lists what earlier rounds found.

Each scenario runs in its own sandbox. The real CLI code runs there, but 1Password, GitHub and Cloudflare are fakes kept in the sandbox's `world.json`, and HOME is the sandbox's own folder, so the real registry, state and accounts are never touched. You play the user: you create vault items, approve the command keypin prints, and read what the fakes hold.

## The driver

```sh
sb() { bun --no-env-file "$(git rev-parse --show-toplevel)/verification/agents/src/main.ts" "$@"; }
sb new /tmp/keypin-round/<scenario>
```

`new` prints the sandbox's `bin/keypin`. It takes keypin's arguments and runs without a terminal, as an agent's shell does. `sb --help` lists the commands you use as the user:

- `item`, `token`, `repo`, `worker`, `env-file`: set up what the user already has. Every value is fake and starts with `keypin-fake-`.
- `approve <sandbox> -- "<keypin's output>"`: run the approval command keypin printed, in a terminal that types `yes` (`--answer no` to decline). It refuses a command that isn't the sandbox's keypin or runs outside the sandbox.
- `show`: what the fake 1Password, GitHub and Cloudflare hold, values as fingerprints (keypin's generation).
- `leaks <sandbox> [transcript...]`: any fake value outside the fakes and the env files you planted. Exit 1 means a value leaked.

The sandbox's `bin/` also holds `op`, `gh` and `wrangler` stubs that fail. They come first on the PATH that `keypin run` passes on.

## Run a round

1. Pick the scenarios the change touches, or all of them for a skill change. Read your diff first, so you know what to watch.
2. For each scenario, make a sandbox and its setup (below) yourself. Make what the user already has (items, tokens, repos, Workers, env files) with the driver's commands. Make earlier keypin state, such as a `discover --write`, a publish or a first rotate run, with the sandbox's `bin/keypin`, approving with `approve`.
3. Start one subagent per scenario, in parallel. Give each:
   - the full text of `skills/keypin/SKILL.md`, as its only guide to keypin;
   - the project folder to `cd` into, and that `keypin` means the sandbox's `bin/keypin` (put the sandbox's `bin` first on its PATH);
   - the task, in the user's words (below);
   - "When you need the user, stop and say what you need. Don't read `world.json` or the driver." Ask it to end with a log of every command it ran, its exit code, and what it told the user.
4. Answer each subagent as the user would: create the items it asks for, run `approve` with the output it hands back, then continue it with the result. Don't fix its commands for it; a wrong guess is a finding.
5. After each scenario, run `show`, and `leaks` with the subagent's transcript saved to a file.
6. Write the report (below). Check every friction against the code or reproduce it in a fresh sandbox before you list it. Leave out what only the sandbox causes, such as the sandbox's paths.

## Scenarios

Each is a setup you make and a task you give. They describe the user's situation, not keypin's output, so they hold as the CLI changes.

1. **Set up a new project.** Setup: a git project with an `origin` on GitHub, a `wrangler.jsonc` whose `secrets.required` names a key, a workflow that uses a secret, an `env-file` `.dev.vars`, and `repo` and `worker` for both. Task: "Set up keypin for this project."
2. **Finish setup after the user names the items.** Setup: scenario 1 after `discover --write`, with `item` for each key. Task: "I created the 1Password items: `<references>`. Finish the setup."
3. **Run with dev keys.** Setup: a map with `dev` entries and their items. Task: "Run `<command>` with my dev keys."
4. **Publish a first write.** Setup: a map with a `prod` entry, its item, `repo` and `worker` for each destination, nothing published. Task: "Publish `<KEY>` to production."
5. **Republish after a change.** Setup: scenario 4 published (you approve), then the item's value changed with `item` again. Task: "I changed `<KEY>` in 1Password; republish it. You can use `--yes` if it's routine."
6. **Rotate an overdue token.** Setup: a `rotate` entry, `token` for the current token with an old `--rotated`, `token --admin` for the admin item, the destinations, and a first publish you approve. Task: "`<KEY>` is overdue. Rotate it."
7. **Finish (revoke) a rotation.** Setup: scenario 6 after its first rotate run, approved. Task: "I started rotating `<KEY>` yesterday and checked the new token works. Finish it."

## The report

Write it for the PR that changes the CLI or the skill:

```md
### Friction round: <scenarios>, keypin <commit>

| Scenario | Outcome | Approvals handed back | Values leaked |
| -------- | ------- | --------------------- | ------------- |

#### Frictions

- **<what got in the way>** (scenario <n>). Evidence: <the command, its exit code, the output line, or the code that causes it>. Suggestion: <the smallest change>.

#### Safety

<each `--yes` used and why; each value printed or passed, if any; each approval the agent ran itself instead of handing back>
```

A round before and after a change shows whether it helped: same scenarios, same setup, both reports in the PR.
