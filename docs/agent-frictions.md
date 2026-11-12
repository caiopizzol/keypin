# keypin frictions for agents and new users

Found by testing [the keypin skill](../skills/keypin/SKILL.md) with seven subagents on keypin 0.3.0, 2026-11-10. Each
ran the real CLI code in a sandbox where 1Password, GitHub and Cloudflare were fakes backed by a JSON file. Every
item below was checked against the code or reproduced; sandbox-only artifacts are left out.

Scenarios: set up a new project, finish setup after the user names the items, run with dev keys, publish a first
write, republish after a change (`--yes` allowed), rotate an overdue token, and finish (revoke) a rotation. keypin
has since removed `rotate`; the items below that concerned only `rotate` are gone from this list.

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

- **1. Without a terminal, `publish` stopped before showing the evidence.** `--plan` reads the value, runs the
  account checks and prints the full plan without a terminal: the generation read from the item, what would be
  written where, and which steps need a typed `yes`. It writes nothing, and exits 3 with the command to run, or 0
  when there's nothing to write. It's a flag, not the default, because reading a value makes 1Password ask the
  user to approve the command, and a plain run without a terminal stops before reading so the user approves only
  once.
- **5. No way to check vault items before publishing.** `keypin check` checks that the map parses, that each
  referenced item exists (from the vault's item list, without reading a value; `run` and `publish --plan` read
  the field), and that each login reaches the pinned account, with a fix for each mismatch. It writes nothing,
  prints no value, and exits 1 with one line per problem. It doesn't report
  `rotated` dates or whether a key is due for rotation; `status` does.
- **3. An empty map looked healthy.** `keypin check` reports a map with no keys as a problem, and an
  unregistered project as a note. `status` reports a registered project with no keys, or still the `init`
  template, as a `no-keys` problem that points at `keypin check`, and exits 1. `init` ends by naming `keypin
  check` as the next step.
- **4. The draft didn't act on the problems it reported.** `discover` and its draft are gone. For each secret a
  workflow references or a Worker's `secrets.required` lists that the map doesn't publish there, `keypin check`
  prints the TOML to add: the `[keys.X.prod]` table with `from` and the `[[keys.X.prod.publish]]` destination,
  with the repo from the git `origin` and the Worker and account from the wrangler config, and `<...>` where it
  can't know the value. The map parser rejects a `<...>`, so a pasted placeholder can't pass as a real reference.
- **7. `status` and `discover` each told half the story.** `keypin check` is the one report for a project: the
  map, the items, the logins, what each workflow and Worker needs against what the repo and Worker hold, and the
  env files. `status` stays the cross-project view of due dates and receipts.
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
- **11. "Nothing to write" trusted the receipt.** keypin can't read a destination's secret, only its own
  receipts. `publish` now says "the receipts on this machine show every destination already got this
  generation".

## Smaller

- "Generation" is never defined in the docs. Say it's a fingerprint of the value.
- `status --json` fields such as `stale: null` aren't documented.
- Timestamps are UTC while `status`'s `today` is local, so "started today" can read as a different day.
- Without a terminal, a plan with no approvals stops with "Add --yes, or confirm in a terminal", but the message
  doesn't say this plan is one `--yes` can approve. Label each plan "routine" or "needs a typed yes".
- `keypin run` warns "no dev entry, not added" on every run for prod-only keys, which reads like a problem.
- The approval command uses the resolved path (`/private/tmp/...` on macOS), not the folder the user is in.
- Install: this Mac had Bun 1.3.12 and keypin needs 1.4.4. The runtime message names the fix, but the README
  could show `bun upgrade` next to the install command.
