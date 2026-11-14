---
name: verify-keypin
description: Run the keypin CLI in a real terminal with fake 1Password, gh, GitHub and Cloudflare, and check what a developer sees (spinners, ✓/✗ steps, [y/N] prompts, colors, plain output) and what it writes. Use after changing a command's terminal output, prompts or exit codes.
---

# Verify keypin in a terminal

`drive.ts` runs one keypin command in a pseudo-terminal, inside a throwaway sandbox, and prints the screen a
person would see. Only outside services are fake.

Never run the real `keypin` binary or `apps/cli/src/main.ts` to check output: the 1Password SDK reaches the
real desktop app even with a sandboxed HOME.

## Run a command

From the repository root (install again after each `git pull`):

```sh
bunx --package vite-plus@1.5.1 vp install
bun apps/cli/tests/terminal/drive.ts --list
bun apps/cli/tests/terminal/drive.ts --scenario ready --answer y publish STRIPE_KEY
```

- `--scenario`: the starting state, from `--list` (default `ready`).
- `--answer`: what to type at each `[y/N]` prompt, in order. Missing answers are Enter, which means no.
- `--cols <n>`: terminal width (default 100). `--plain`: no terminal. `--no-color`: `NO_COLOR=1`.
- Everything after these options goes to keypin.

The output ends with:

```
--- exit 3 · effects 0 · leaks 0 · overlong frames 0
effect: <one line per write to fake 1Password or a destination>
evidence: .verify/<run>/
```

`effects` is the only proof of whether keypin wrote anything. `leaks` and `overlong frames` must be 0; if not,
`drive.ts` exits 1. The evidence folder holds `screen.txt`, `raw.txt` (with escape codes) and `frames.txt` (each
spinner frame).

## Lock it in a test

Add or update the journey in `apps/cli/tests/terminal/journeys.test.ts`, which CI runs. `drive()` takes the same
options and returns `exit`, `screen`, `effects`, `files`, `frames`, `leaks` and `overlong`.

```sh
bun --bun vp test apps/cli/tests/terminal
```

For a new starting state, add a scenario to `apps/cli/tests/terminal/scenarios.ts`.
