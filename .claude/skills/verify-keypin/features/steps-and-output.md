# Steps and output modes

Every slow step (1Password reads, account checks, writes) shows a spinner on stderr, then replaces it with one
line: a green `✓` or red `✗`, what happened, and how long it took. After one second, a step that can wait on a
1Password approval adds a dim hint. Without a terminal, or with `NO_COLOR` or `TERM=dumb`, there are no escape
codes and the mark is `ok    ` or `FAILED`.

## Sub-features

- `step-finish`: each spinner ends as one finished line with a mark and a time, and no spinner glyph remains.
- `step-fail`: a failed step says what failed (`Couldn't look up 2 of 2 items…`), not what it was doing.
- `step-hint`: after 1s, `1Password may be asking you to approve keypin` shows beside the label.
- `step-width`: no spinner frame is wider than the terminal, so redraws never leave wrapped lines.
- `plain`: piped output and `NO_COLOR` have no escape codes and use `ok    ` / `FAILED`.

## How to get to it (user POV)

- Any command that reads 1Password or checks an account: `check`, `run`, `publish`, `status`, `import`.

## Driving it with drive.ts

Preconditions:

- The scenarios `ready`, `slow-1password` and `unknown-account` exist.

- **Finish.** `D check`. The screen has `✓ Looked up 2 items in 1Password account my.1password.com, not the values  0.0s` and `✓ Checked 1 account  0.0s`, and no `⠋⠙⠹…` glyph.
- **Fail.** `D --scenario unknown-account check`. The screen starts `✗ Couldn't look up 2 of 2 items…` and `✗ 1 of 1 account failed the check`.
- **Hint.** `D --scenario slow-1password --cols 60 run -- true`. `frames.txt` has frames ending `1Password may be asking you to approve key…`; the summary says `overlong frames 0`.
- **Plain.** `D --plain --scenario unknown-account check` and `D --no-color --scenario unknown-account check`. `raw.txt` has no `ESC[`; steps start `FAILED `.

## Gotchas

- The spinner draws only while work is pending. Fake steps finish in 0.0s, so `ready` shows one frame per step;
  use `slow-1password` to see the hint and real redraws.
- `--plain` runs keypin with pipes, so stdin isn't a terminal either. Commands that would prompt stop with exit 3
  and print the approval command instead.
- `screen.txt` shows the screen after redraws. To check a single frame, read `frames.txt`.
