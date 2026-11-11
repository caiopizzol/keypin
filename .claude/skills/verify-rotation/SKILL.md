---
name: verify-rotation
description: Model-check keypin rotate with TLA+ to find orders of runs, crashes and publishes that leave a revoked Cloudflare token in use. Use when a change touches rotate.ts, publishing.ts, publish.ts, rotations.ts or the receipt planning in plan.ts, or when asked whether rotation is safe.
metadata:
  internal: "true"
---

# Verify rotation

`verification/rotation/Rotate.tla` models `keypin rotate` across runs, crashes and `keypin publish` runs in between. A comment above each action names the code it models. Its rules:

- `DestinationsWork`: every destination listed for the vault item holds a working token.
- `VaultWorks`: the vault item holds a working token.
- `NoForgottenToken`: every working token is in use, or recorded in `rotations.json`.

## Check a change

1. Read your diff against the actions in `Rotate.tla`. If the diff changes a modeled step, its order, or a guard, update that action to match the code. Keep each `await` that changes Cloudflare, 1Password, a destination or a state file as its own action.
2. Run `verification/rotation/check.sh` (needs Java 11+; about 15 s). It exits 0 when every result matches its `expected` table.
3. Read each line that isn't `ok`:
   - `guard missing`: code that the model depends on changed. Do step 1, and update the entry in `guards`.
   - A rule `breaks` where `holds` is expected: replay TLC's path in `verification/rotation/out/` against the code. If the code can take every step, it's a bug: report the path in the code's terms, and don't weaken the rule or the model. If the code can't take a step, fix the model.
   - A mutant that doesn't break: a rule can no longer fail. Fix the model or the mutant.
4. Keep model changes only for code that will land. If the change is a bug, put the model back and report it.
5. If your change fixes an open finding, change its `expected` line to `holds`.

Read TLC's paths with the pstack `/statechart` skill when it's available.

## Open findings

`check.sh` expects this break:

- `LostReceipt`: a run stops after a destination write but before its receipt is saved, and then someone restores the item. `abandon()` sees no receipt with the new token, so it deletes a token that destination holds. Destinations can't be read back, so no receipt check can close this.

## Scope

Bounds: 2 new tokens, up to 3 destinations, one other key in the same `state.json`. Not modeled: approvals, removing a destination, secrets set by hand outside keypin (no receipt), tokens that expire or are revoked outside keypin, and token contents.

## Sync

Last confirmed against `4166181d2ba0c169992b87f9f6fb73f0bd56657e`. When `check.sh` prints `NOTE`, covered code changed after that commit. Move the commit forward, in this file and in `check.sh`, only after you confirm the model describes the new code. A change can't name its own commit, so point at its parent and leave the `NOTE` until a later change moves it.
