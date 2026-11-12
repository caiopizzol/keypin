# keypin frictions for agents and new users

Found by testing [the keypin skill](../skills/keypin/SKILL.md) with seven subagents on keypin 0.3.0, 2026-11-10. Each
ran the real CLI code in a sandbox where 1Password, GitHub and Cloudflare were fakes backed by a JSON file. Every
item below was checked against the code or reproduced; sandbox-only artifacts are left out.

Scenarios: set up a new project, finish setup after the user names the items, run with dev keys, publish a first
write, republish after a change (`--yes` allowed), rotate an overdue token, and finish (revoke) a rotation.

All seven agents stayed safe: none used `--yes` where it can't approve, none printed a value, and each handed the
approval command back to the user.

## Fixed in this Stack

- **`keypin run` passed `.env` values the vault never supplied.** Bun loads the current folder's `.env` files
  into `process.env` before keypin starts. The bin now starts Bun with `--no-env-file`, and keypin refuses to run
  without it.
- **Exit code 2 meant both a usage error and a stop for approval.** Approval stops now exit 3, and `keypin --help`
  lists every exit code.
- **Subcommands had no `--help`.** `keypin publish --help` printed "Unknown option" and exited 2.

### Retest

The same seven scenarios, run again against these fixes:

- No agent reported a value it couldn't explain, and `keypin run` no longer warns that a variable "was already
  set" when the shell didn't set it.
- Agents read exit 3 as "the user must approve" without guessing, and `keypin <command> --help` worked.
- The routine update went as intended: the agent ran `publish` without `--yes`, read the plan (exit 3), saw an
  ordinary update, then reran with `--yes`. It was the only run that wrote anything.

## Fixed since

- **`discover` didn't say where the GitHub login came from.** It now says `as <login> (git config
  github.account)` or `as the active gh login`, and `publish` picks its GitHub login the same way.
- **1. Without a terminal, `publish` and `rotate` stopped before showing the evidence.** `--plan` reads the
  value, runs the account checks and prints the full plan without a terminal: the generation read from the item,
  what would be written where, and which steps need a typed `yes`. For a revoke run, it adds the old token's
  last-used time. It writes nothing, and exits 3 with the command to run, or 0 when a publish has nothing to
  write. It's a flag, not the default,
  because reading a value makes 1Password ask the user to approve the command, and a plain run without a
  terminal stops before reading so the user approves only once. The note to coordinate with a separate revoke
  change was stale: that change was #19, which merged minutes before this list did.
- **2. `init` and `discover` didn't connect.** `keypin discover --write` saves the draft as `keypin.toml` and
  registers the project, when there's no `keypin.toml` or it's still the untouched `init` template. It refuses
  to change a real map; copy the `[keys.*]` tables from the draft by hand.
- **6. First setup meant one publish per key.** `keypin publish --all` publishes every key with destinations in
  the environment, with one combined plan and one typed `yes`. Without a terminal it lists every approval and
  stops with exit 3 before reading any value.
- **8. `missing-receipt` was a problem even before the first publish.** A key and environment this project has
  never published is now one `never-published` notice that names the `keypin publish` command, and `status`
  exits 0. `missing-receipt` stays a problem when this project published the key before but a destination has no
  receipt (added later, or the receipt was lost), or when the destination's last receipt is from another project
  and another item.
- **9. `authority-unknown` appeared on every key.** It's gone, along with the row's `authority` field, which was
  always `"unknown"`.

## Getting started

### 3. An empty map looks healthy

After `init`, `status --json` returns no rows and no problems, exactly as before `init`. Nothing says the project
is registered with zero keys, or that `keypin.toml` is still the template. Report "registered, no keys mapped".

### 4. The draft doesn't act on the problems it reports

`discover` reports that `wrangler.toml` requires `RESEND_API_KEY` and the Worker lacks it, but the draft gives
that key no `prod` entry or Worker destination. It reports a workflow that uses `STRIPE_API_KEY` with no repo
secret, but adds no GitHub destination. Draft a destination for each `secrets.required` name and each workflow
reference, so the draft fixes what discover found.

### 5. No way to check vault items before publishing

There's no command to check that the map's vault items exist and have `password`, `rotated` and `rotate_every`.
`status` reads only the rotation fields, and only after the map is saved. Agents had to ask the user for every
item name. A `keypin check` (map valid, items exist, fields present, logins reach accounts) would let an agent
finish setup and say "valid" with evidence.

## Day to day

### 7. `status` and `discover` each tell half the story

`status` shows due dates and receipts; only `discover` shows what a repo or Worker actually holds. Agents that
followed "check with `status`" missed a Worker without a required secret. Consider showing discover's cloud
problems in `status` for registered projects, or a single `keypin doctor`.

### 10. Rotation's admin token isn't checked

`status` reads only each environment's item, not `rotate.admin`, though `docs/rotation.md` says the admin item
has its own `rotated` and `rotate_every`. A missing or expired admin token shows up only when `rotate` fails.

### 11. "Nothing to write" trusts the receipt

`publish` skips a destination when its receipt has the same generation. It doesn't read the destination (it
can't, for secrets). The output should say "receipt matches", not imply the destination holds the value.

## Smaller

- "Generation" is never defined in the docs. Say it's a fingerprint of the value.
- `status --json` fields such as `stale: null` aren't documented.
- Timestamps are UTC while `status`'s `today` is local, so "started today" can read as a different day.
- Rotation stages (`issued`, `published`, …) aren't explained.
- Without a terminal, a plan with no approvals stops with "Add --yes, or confirm in a terminal", but the message
  doesn't say this plan is one `--yes` can approve. Label each plan "routine" or "needs a typed yes".
- `rotate`'s first-run stop doesn't say it's run 1 of 2.
- `keypin run` warns "no dev entry, not added" on every run for prod-only keys, which reads like a problem.
- The approval command uses the resolved path (`/private/tmp/...` on macOS), not the folder the user is in.
- Install: this Mac had Bun 1.3.12 and keypin needs 1.4.4. The runtime message names the fix, but the README
  could show `bun upgrade` next to the install command.
