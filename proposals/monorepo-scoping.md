# Proposal: monorepo scoping for check and status

How keypin should work in a monorepo where projects share one workflows folder and keys are adopted one at a time.
For review; nothing here is built yet.

## Problem

Take a monorepo with one `.github/workflows/` holding many workflows, wrangler configs for several Workers under
`services/`, and two `secretspec.toml` files: `ci` at the root, which manages CI keys, and `evals` in `apps/evals/`,
which has dev keys only.

1. `keypin check apps/evals` reads every workflow in the repo and asks to declare every production key those
   workflows use, though evals uses none of them. There's no way to say which workflows or Workers belong to a
   project.
2. The root `ci` project declares one key. It passes `check` only by listing every other workflow and Worker secret
   under `[tool.keypin] ignore`. Those names mean "not yet", not "never", but `ignore` hides them for good, and
   `status` can't count them.
3. `check` registers each folder by absolute path. Every git worktree of the repo becomes its own project in
   `keypin status`, and a deleted worktree shows as a problem until someone runs `keypin unregister`.

What keypin does today:

- It reads workflows from the repo root's `.github/workflows/`, whatever the project folder
  (`packages/connectors/src/github/discovery.ts:92`).
- It finds wrangler configs and env files by walking down from the project folder, stopping only at a nested git
  repo (`apps/cli/src/scan.ts:171`).
- `ignore` drops a name from every gap and adds one note, "secretspec.toml ignores N keys"
  (`packages/core/src/gaps/index.ts:39`).
- Any other name under `[tool.keypin]` is read as a profile (`packages/core/src/map/tool.ts:36`). keypin 0.42.0
  rejects `pending = [...]` with `[tool.keypin.pending]: secretspec.toml has no [profiles.pending]`. A profile name
  uses lowercase letters, digits and dashes, so a new setting needs a name with `_` to never clash with one.
- The registry is a sorted list of absolute paths (`packages/core/src/registry.ts`), and local receipts record each
  key's `secretspec.toml` by absolute path (`packages/core/src/state.ts:14`).

secretspec ignores `[tool.*]`, so every option below lives under `[tool.keypin]` and secretspec reads the file as
before.

## Options

### A. A project lists the files it owns

```toml
# apps/evals/secretspec.toml: a dev-only project owns no workflows or Workers
[tool.keypin]
scan_files = []

# secretspec.toml at the root
[tool.keypin]
scan_files = [".github/workflows/review.yml", ".github/workflows/rotate-keys.yml"]
```

`scan_files` lists workflows and wrangler configs as globs from the repo root, such as
`.github/workflows/evals-*.yml` or `services/api/wrangler.jsonc`. Only those report key gaps. Without `scan_files`,
every file does, as today.

- Env files in the project folder always count.
- With `scan_files`, keypin reads every wrangler config in the repo, from its root, for service bindings, and
  reports gaps only for owned ones. An owned Worker that only a sibling project's config calls still counts as
  deployed. Today discovery walks down from the project folder, so a subfolder project never sees that call.
- `rotate` still looks for `secretspec run` jobs in every workflow. A job can read a key at run time without naming
  a GitHub secret, so the revoke plan mustn't miss it.
- `check` prints how many files it left out, such as `read 0 env files, 0 wrangler configs, 2 workflows (158 not in
  scan_files)`. evals stops seeing production keys at all. `status` doesn't change.
- From `ignore`: `check` notes each ignored name that no owned file uses, so you can remove it. What stays is what
  the owned files really use: keypin's own credentials in `rotate-keys.yml`, and any other key an owned workflow
  passes that the project hasn't adopted yet.

### B. A `pending_keys` list next to `ignore`

```toml
[tool.keypin]
ignore = ["KEYPIN_GITHUB_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN"]
pending_keys = ["ANTHROPIC_API_KEY", "XAI_API_KEY"]
```

`ignore` means never. `pending_keys` means not yet.

- `check` passes and prints one line: `2 keys pending: ANTHROPIC_API_KEY, XAI_API_KEY`.
- `status` shows the count under each project: `2 keys not managed yet`. It reads the count from
  `secretspec.toml`, so it needs no scan.
- From `ignore`: move the names across by hand. A name in both lists is an error.
- It doesn't fix the evals case: those keys belong to other projects, not to evals. Each subfolder project would
  carry its own copy of the repo's names, and the lists go stale as workflows change.

### C. keypin works out ownership from paths

No config. A workflow belongs to a project if it runs `secretspec run` in the project folder (keypin already does
this for job readers, `discovery.ts:81`), or its `on.*.paths` filters all sit inside it. A wrangler config belongs
to the nearest `secretspec.toml` above it. Whatever no project claims goes to the root.

- Many workflows that use secrets have no `paths` filter, and a review or release workflow is repo-wide by nature.
  The root still owns almost everything, so case 2 stays as it is.
- A guess about ownership is hard to explain when it's wrong, and there's no way to correct it.

## Project identity in status

Group the worktrees of one clone, not separate clones: two clones of the same repo can use different vaults or
destinations. A checkout's identity is its shared git directory (`git rev-parse --git-common-dir`) and its folder
within the repo, such as `apps/evals`.

- `check` records that identity in the registry while the checkout exists, in a new `checkouts` field next to
  `projects`. `projects` stays a list of paths, so a released keypin still reads the file. If an older keypin
  rewrites the registry and drops `checkouts`, the next `check` or `status` fills it in again for paths that exist.
- `status` shows one project per identity. It reads `secretspec.toml` from the clone's main worktree when the file
  is there, else from the first existing checkout in path order.
- A gone path with a recorded identity, when another checkout of it exists, is hidden by `status` and removed by
  the next `check`. A gone path with no recorded identity (registered before this change) or no other checkout
  becomes a notice with `keypin unregister <path>`, not a problem that fails `status`.
- Each new receipt also records its checkout's identity next to `mapFile`. It doesn't depend on the registry:
  pruning a path or an older keypin dropping `checkouts` leaves it in place, and older keypins keep a receipt's
  unknown fields when they rewrite the state file (`packages/core/src/state.ts:51`).
- Identity adds a match; it removes none. `status` still accepts a receipt by its path or by the vault item it
  names (`packages/core/src/status.ts:155`), so receipts written before this change keep matching as they do today.
- A folder outside git keeps its absolute path as its identity.

## Recommendation

Option A. It fixes the cause: a project in a monorepo inherits the whole repo. It solves case 1 outright and
shrinks the root's `ignore` list to the names its owned files use. B is a small follow-up if those names should
count as "not yet" in `status`; without A it would only rename the list. C can't place repo-wide workflows.

Smallest first increment:

1. `[tool.keypin] scan_files`, applied to the key gaps `check` reports from workflows and wrangler configs.
2. The `check` note for ignored names no owned file uses.
3. Docs: one section in [secretspec.toml](../docs/reference/secretspec-toml.md#toolkeypin).

Project identity ships separately, after A.

A repo that pins keypin in CI upgrades that pin, and keypin on laptops, before adding `scan_files`, since 0.42.0
rejects any new field.

Open questions for the owner:

- Globs from the repo root, or from the `secretspec.toml` folder? The root reads more plainly for workflows, which
  always live there.
- Does `scan_files` cover env files too, for a project that reads a `.env` outside its folder? This proposal says
  no.
- Where should proposals live? `docs/` checks that every page is listed on keypin.dev and that every TOML example
  parses today, so this one sits in a top-level `proposals/` folder.
