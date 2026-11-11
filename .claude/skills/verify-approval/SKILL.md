---
name: verify-approval
description: Exhaustively check keypin's publish approval gate, so that --yes never writes a secret to a new destination, a changed account or from a changed vault item. Use when a change touches plan.ts (planPublish, approvalsFor, latestPerSecret), secretKey, destinationId or receiptSecretKey in map.ts, recordReceipt in state.ts, sameRef or sameItem in reference.ts, or the confirm steps in publish.ts and rotate.ts, or when asked whether --yes is safe.
metadata:
  internal: "true"
---

# Verify the approval gate

`keypin publish --yes` and `keypin rotate --yes` skip the typed `yes` only when no plan step needs approval. The steps come from `planPublish` and `approvalsFor` in `packages/core/src/plan.ts`. If they wrongly mark a step as routine, an agent with `--yes` can write a secret to a destination nobody approved, under an account nobody approved, or from a vault item nobody approved.

`verification/approval/check.ts` runs the real `@keypin/core` code. It builds every receipt history of up to 2 earlier publishes with the real `recordReceipt`, plans a publish after each history, and compares the plan with rules written separately in terms of the real secret each destination stands for:

- `NoSilentWrite`: a write step has no approval only if the last keypin write to that exact secret, from any key or project, came from the same vault item under the same pinned account.
- `NoStaleSkip`: a step is skipped only if the last write to that exact secret has this generation.
- `ApprovalsAgree`: `approvalsFor` lists exactly the steps that `planPublish` marks for approval. `publish` uses `approvalsFor` to stop before reading a value, and a first `rotate` run confirms from it and then publishes without asking again.

"The same secret" is defined by hand in the script's `PLACES`, not with `secretKey`: GitHub repo and secret names ignore case, and a Cloudflare secret belongs to one account and one Worker.

## Check a change

1. Run `bun verification/approval/check.ts` from the repo root. It takes about 25 s with the mutants, or 4 s with `--no-mutants`. It exits 0 when every line is `ok`. No tool beyond the repo's Bun is needed.
2. Read each line that isn't `ok`:
   - `guard missing`: a line in `publish.ts` or `rotate.ts` that turns the plan into a prompt changed. The script checks only the plan, so this glue is pinned as exact code in `GUARDS`. Read the new code. If `--yes` still passes only when nothing needs approval, update the entry. If not, it's a bug: report it.
   - A rule `breaks`: the script prints the shortest history in keypin's terms, such as "API_TOKEN (prod) in /p/app is published from op://Private/app prod to github me/app (account me)", then the publish and the step that went wrong. Ask whether keypin could really produce that history: one map file, each line a `keypin publish` from that map's key and item to that destination. If it could, it's a bug. Report the history and don't change the rules. If it couldn't, for example because the script builds a receipt that `writeAll` in `apps/cli/src/publishing.ts` never writes, fix how `stateAfter` builds receipts.
   - A mutant whose rule `still holds`: the rule can no longer see the bug that the mutant adds. Mutant code that is no longer in the file is reported too. Point the mutant at the new code, or replace it with one that breaks its rule.
3. If the change is meant to alter who needs approval, such as a new destination kind or a new approval reason, change the rule in `mayWriteSilently` or `PLACES` first, run the script, and confirm that the old code fails the new rule. For a new destination kind, add its places to `PLACES`, with `secret` written from how that service names secrets, not from `secretKey`.

The rules are about safety only. A change that makes keypin ask for approval more often, or write a destination that already has the value, passes. For example, if `receiptSecretKey` drops the Cloudflare account, keypin asks again after a write to the same Worker in another account. That's a nuisance for the user, but no rule here breaks.

## Scope

Verified, for every combination in the bounds: plans for `API_TOKEN` (prod) in `/p/app`, from one of two vault items, to one or two of five destinations: GitHub `me/app` and `Me/App` pinned to `me`, `me/app` pinned to `org`, and Worker `app` in two Cloudflare accounts. They run after every history of up to 2 earlier publishes. Each earlier publish comes from one of 4 owners: this key, `api_token` in the same map, the same key in another map, or its dev entry. It goes to one of the 5 destinations, from one of 4 items (one is the same item in another case, one is the same title in another 1Password account) or a legacy receipt with no item, at one of 2 generations. That's 1,206,030 plans.

Not verified: histories of 3 or more publishes, receipts that `recordReceipt` didn't make (hand-edited or older `state.json` files with duplicate receipts), how `destination.checkAccount` decides that a login reaches the pinned account, Cloudflare secret names that differ only in case (treated as different secrets), and `rotate`'s revoke step, which `verify-rotation` covers.

## Sync

Covered: `packages/core/src/plan.ts`, `packages/core/src/map.ts` (`secretKey`, `destinationId`, `receiptSecretKey`), `packages/core/src/state.ts` (`recordReceipt`), `packages/core/src/reference.ts` (`sameRef`), and the confirm steps in `apps/cli/src/commands/publish.ts` and `apps/cli/src/commands/rotate.ts`.

Last confirmed against `f58c3333097fe40b7eb4d04bf14a7ef0ef98d808` (`SYNC` in `check.ts`). When the script prints `NOTE`, covered code changed after that commit. It still runs the new code, but the rules and `GUARDS` may no longer describe it. Move `SYNC` forward only after you have read the change and confirmed that the rules still state what keypin promises. A change can't name its own commit, so point at its parent and leave the `NOTE` until a later change moves it.
