---
name: verify-keypin
description: Drive the keypin CLI in a real pseudo-terminal, the way a developer sees it (spinners, ✓/✗ steps, [y/N] prompts, colors, plain output), with fake 1Password, gh, GitHub and Cloudflare, and capture the screen and side effects as evidence. Use after changing any keypin command's terminal output, prompts or exit codes, or to prove a journey works before opening a PR.
---

# Verify keypin in a terminal

keypin's unit tests call `cli()` with in-memory fakes and `styled: false`, so they never see what a terminal shows.
This skill runs the real CLI under a real pseudo-terminal (Bun's `Bun.spawn({ terminal })`), so stdin, stdout and
stderr are TTYs, `NO_COLOR`/`TERM` apply, the width is real, and prompts are answered by typing.

Only the outside world is fake. [`child.ts`](../../../apps/cli/tests/terminal/child.ts) runs keypin's own
`cli()` with `realDeps()` from `apps/cli/src/start.ts` (real disk, git, locks, prompt, styling), and replaces
five things per scenario: the 1Password SDK (behind the real `onePasswordBackend`, so its error handling runs),
the gh login, the wrangler login, reading GitHub/Cloudflare secrets, and each destination's account check and write.

## Never touch the real accounts

- The 1Password SDK talks to the desktop app directly. A sandboxed HOME does not stop it. Never run the real
  `keypin` binary or `apps/cli/src/main.ts` against a map to check output. Use `drive.ts`, whose child
  refuses to start outside a sandbox it made.
- Never add a scenario that calls the real `desktopConnect`, `gh`, or a real API.
- Each drive makes its own sandbox under the OS temp folder (`keypin-verify-*`, with its own HOME and
  XDG folders and a git repository named `billing`) and deletes it afterwards. Drives can run side by side.

## Launch

From the repository root, once per checkout:

```sh
bunx --package vite-plus@1.5.1 vp install
```

There is no server. Each command below is one drive: set up a sandbox, run one keypin command in a new terminal,
save evidence, delete the sandbox.

## Doctor

```sh
bun --version                                   # 1.4.4, from package.json devEngines
bun apps/cli/tests/terminal/drive.ts --list     # the scenarios
bun apps/cli/tests/terminal/drive.ts --version
```

The last line must print the version in `package.json` and end `--- exit 0 · effects 0 · leaks 0 · overlong frames 0`.
If `--list` fails to import, run the install again. If it says `child.ts runs only inside a sandbox`, something
ran `child.ts` directly; always go through `drive.ts`.

## Drive

```sh
bun apps/cli/tests/terminal/drive.ts [--scenario <name>] [--cols <n>] [--answer <text>]... [--plain] [--no-color] [--keep] [--out <dir>] <keypin args>
```

- `--scenario`: the starting state (default `ready`). Each is defined in
  [`scenarios.ts`](../../../apps/cli/tests/terminal/scenarios.ts); `--list` prints what each one sets up.
- `--answer`: what to type at each `[y/N] ` prompt, in order. A prompt with no answer left gets Enter, which is no.
- `--cols`: terminal width (default 100). Try 60 for narrow terminals.
- `--plain`: no terminal at all (pipes), as in CI or `| less`. `--no-color`: a terminal with `NO_COLOR=1`.
- `--keep`: keep the sandbox and print its path, to inspect files by hand. Delete it when done.
- keypin's arguments start at the first word that isn't one of these options. Put `--` before them when they
  start with one of these names, as in `drive.ts -- --plain`.

The command prints the rendered screen (what a person sees after every redraw), then one summary line:

```
--- exit <code> · effects <n> · leaks <n> · overlong frames <n>
effect: <one line per write keypin made to a fake 1Password or destination>
evidence: <folder>
```

It exits 1 if a vault or `.env` value reached the terminal (`leaks`) or a spinner frame was wider than the
terminal (`overlong frames`), whatever keypin's own exit code.

For the journeys, the steps and the expected screens, read [features/README.md](features/README.md) and the
feature file for what you changed.

## Evidence

Each drive writes to `.verify/<time>-<scenario>-<args>/` at the repository root (git-ignored):

- `screen.txt`: the rendered screen. Compare it with what the change meant to show.
- `raw.txt`: the exact bytes, escape codes included. Check colors or `NO_COLOR` here.
- `frames.txt`: every spinner frame, one per line. Check the hint and the width here.
- `files.json`: `keypin.toml`, `.env`, the registry and `state.json` after the run (sandbox path shown as `<sandbox>`).
- `summary.json`: scenario, args, width, exit code, effects, leaks, overlong frames.

A proof is: the command, `screen.txt`, the exit code, and the side effects (`effects` plus `files.json`), all
from one drive. A screen alone doesn't prove a write happened or didn't. `effects` is the only record of writes,
because the fakes record every create, update and destination write.

## Lock it in a test

Every journey in the feature map has a test in
[`journeys.test.ts`](../../../apps/cli/tests/terminal/journeys.test.ts), which `bun run test` runs in CI.
`drive()` from `drive.ts` returns the same fields as the evidence. When a change adds or alters terminal
behavior, add or update the test there and see it fail before the change.

```sh
bun --bun vp test apps/cli/tests/terminal
```

To tell a real bug from a harness mistake: run the same journey with `--plain`. If the plain output is right
and the terminal one isn't, the bug is in styling or redraws (`apps/cli/src/output.ts`). If both are wrong, it's
the command. If keypin behaves but the screen looks garbled, `render()` in `drive.ts` may not know an escape
sequence the change started using; read `raw.txt` and teach `render()` that sequence.

## Add a scenario

Add an entry to `scenarios` in `scenarios.ts`: files to put in the project, whether it's registered, git origin
and `github.account`, 1Password accounts → vaults → items (title, value, rotated day), gh and wrangler state,
the GitHub secrets the repo has, and per place (`github-actions:<repo>` or `cloudflare-worker:<worker>`) a
failing account check or write. Give every value 8 characters or more, so the leak check can spot it. Use
`day(offset)` for rotated dates, so "due in N days" stays true over time.

## Cleanup

Drives delete their own sandbox. After `--keep`, delete the printed folder. Delete `.verify/` when you no longer
need the evidence. Never delete it during a verification you'll report on.
