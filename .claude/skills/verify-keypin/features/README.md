# keypin terminal verification map

The maintained list of what a developer sees from each keypin command, and how to prove it with
`apps/cli/tests/terminal/drive.ts`. Read [the skill](../SKILL.md) first.

## Baseline preconditions

- Run from the repository root after `bunx --package vite-plus@1.5.1 vp install`.
- Every drive starts from a named scenario in `apps/cli/tests/terminal/scenarios.ts`, in a fresh sandbox.
- No drive reaches the real 1Password, gh, GitHub or Cloudflare.

## Driving conventions

- `D` below stands for `bun apps/cli/tests/terminal/drive.ts`.
- keypin's arguments follow the harness options; `--` between them is optional.
- Answers to `[y/N]` go in `--answer`, one per prompt.
- Times in finished steps vary; match `\d+\.\ds`, not a number.

## Proof and skip reporting

- Report the command, `screen.txt`, the exit code and the `effect:` lines from one drive.
- For a write, `effects` must list it. For "nothing was written", `effects` must be empty.
- `leaks 0` and `overlong frames 0` hold on every drive.
- If a journey can't be driven because no scenario sets up its state, say which state is missing; don't
  report it as verified through another journey.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then four H2
sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.ts`, `Gotchas`.

## Features

- [Steps and output modes](./steps-and-output.md): spinners, ✓/✗ lines with times, the slow 1Password hint, plain and `NO_COLOR` output.
- [publish](./publish.md): plan, `[y/N]`, writes, and refusing without `y`.
- [check](./check.md): numbered next steps, the all-clear line, and sign-in problems.
- [status](./status.md): keys grouped by project, due dates, places and notices.
- [import, init and usage](./import-init-usage.md): moving `.env` keys into 1Password, a new project, typos.
