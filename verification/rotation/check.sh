#!/usr/bin/env bash
# Model-checks keypin rotate (Rotate.tla) with TLC, one rule at a time.
#   verification/rotation/check.sh             every config and rule, then every mutant
#   verification/rotation/check.sh SharedItem  one config's rules
# Exits 0 when every result matches the table below and every mutant breaks its rule.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
version=1.7.4
sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jar="${TLA2TOOLS:-${XDG_CACHE_HOME:-$HOME/.cache}/keypin-verify/tla2tools-$version.jar}"

if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  curl -fsSL -o "$jar.part" "https://github.com/tlaplus/tlaplus/releases/download/v$version/tla2tools.jar"
  mv "$jar.part" "$jar"
fi
if [ "$(shasum -a 256 "$jar" | cut -d' ' -f1)" != "$sha" ]; then
  echo "check.sh: $jar isn't tla2tools $version (its sha256 differs)" >&2
  exit 2
fi

java_major() { "$1" -version 2>&1 | sed -nE '1s/.*version "(1\.)?([0-9]+).*/\2/p'; }
java="${JAVA:-}"
if [ -z "$java" ]; then
  for candidate in java /opt/homebrew/opt/openjdk/bin/java /opt/homebrew/opt/openjdk@21/bin/java /usr/local/opt/openjdk/bin/java; do
    if command -v "$candidate" >/dev/null 2>&1 && [ "$(java_major "$candidate")" -ge 11 ] 2>/dev/null; then
      java="$candidate"
      break
    fi
  done
fi
if [ -z "$java" ]; then
  echo "check.sh: TLC needs Java 11 or newer. Install one (brew install openjdk) or set JAVA." >&2
  exit 2
fi

# Every config, every rule, and the result it must give. A "breaks" line is an
# open finding in .claude/skills/verify-rotation/SKILL.md. When the code fixes
# one, its line becomes "holds".
expected=(
  "Rotate TypeOK holds"
  "Rotate DestinationsWork holds"
  "Rotate VaultWorks holds"
  "Rotate NoForgottenToken holds"
  "SharedItem TypeOK holds"
  "SharedItem DestinationsWork holds"
  "SharedItem VaultWorks holds"
  "SharedItem NoForgottenToken holds"
  "OutsideEdit TypeOK holds"
  "OutsideEdit DestinationsWork holds"
  "OutsideEdit VaultWorks holds"
  "OutsideEdit NoForgottenToken holds"
  "LostReceipt TypeOK holds"
  "LostReceipt DestinationsWork breaks"
  "LostReceipt VaultWorks holds"
  "LostReceipt NoForgottenToken holds"
)

# Each mutant removes one guard of the code from the line of Rotate.tla tagged
# "\* mutant: <name>", and must break the rule that guard protects in that config.
# name | what replaces the tagged line | config | rule it must break
mutants=(
  "revoke-skips-receipts|  /\\ TRUE|Rotate|DestinationsWork"
  "revoke-skips-other-keys|  /\\ TRUE|SharedItem|DestinationsWork"
  "revoke-skips-item-read|  /\\ TRUE|OutsideEdit|VaultWorks"
  "abandon-skips-item-read|  /\\ TRUE|Rotate|VaultWorks"
  "abandon-skips-receipts|  /\\ TRUE|OutsideEdit|DestinationsWork"
  "issue-before-record|  /\\ rot' = rot|Rotate|NoForgottenToken"
)

# The model is written by hand, so TLC can't see the TypeScript. Each guard
# below is modeled in Rotate.tla; when its code is gone or changed, the model may
# no longer describe the code, and a pass means nothing until you update it.
# file | exact code | the action in Rotate.tla that models it
guards=(
  "apps/cli/src/commands/rotate.ts|  await saveRotations(deps.files, run.rotationsPath, data);

  const made = await provider.issue({ name, like: old, expiresOn });|Start saves \"issuing\" before Issue"
  "apps/cli/src/commands/rotate.ts|    await vault.write(entry.ref, made.value, { rotated: today, item: ids });|Store"
  "apps/cli/src/commands/rotate.ts|  rotation = { ...rotation, stage: \"stored\", updatedAt: deps.now().toISOString() };|SaveStored after Store"
  "apps/cli/src/commands/rotate.ts|    if (generation !== rotation.new.generation) {|ResumeStored: vault = rot.new"
  "apps/cli/src/commands/rotate.ts|  if (!written.ok) {|SavePublished only after every write"
  "apps/cli/src/commands/rotate.ts|  const behind = plan.steps.filter((step) => step.action === \"write\");|RevokeStart: every receipt has rot.new"
  "apps/cli/src/commands/rotate.ts|  if (behind.length) {|RevokeStart: every receipt has rot.new"
  "apps/cli/src/commands/rotate.ts|  if (current?.status !== \"active\") {|RevokeStart: tok[rot.new] = active"
  "apps/cli/src/commands/rotate.ts|  if (others.length) {|RevokeStart: no other key's receipt has rot.old"
  "apps/cli/src/commands/rotate.ts|    if (owner) return [{ receipt, owner }];|RevokeStart: another map's listed destination counts as OtherDests"
  "apps/cli/src/commands/rotate.ts|      return null;
    }
    list(result.map, project);|RevokeStart: an unreadable registered map stops, so OtherDests is never empty by accident"
  "apps/cli/src/commands/rotate.ts|  if (holds !== generation) {|RevokeStart: vault = rot.new"
  "apps/cli/src/commands/rotate.ts|    const holders = holdersOf(state.receipts, rotation.new.generation);|AbandonDelete: no receipt has rot.new"
  "apps/cli/src/commands/rotate.ts|  return latestPerSecret(receipts).filter((r) => r.generation === generation);|holdersOf reads each secret's latest receipt"
  "apps/cli/src/commands/rotate.ts|    if (holds === rotation.new.generation) {|AbandonToStored: vault = rot.new"
  "apps/cli/src/commands/rotate.ts|    if (holds !== rotation.old.generation) {|AbandonDelete: vault = rot.old"
  "apps/cli/src/publishing.ts|      const evidence = await found.destination.write(key.name, secret);|PublishWrite, then PublishReceipt"
  "apps/cli/src/publishing.ts|  const taken = await deps.lock(lockFile);|Unlocked"
  "packages/core/src/plan.ts|    if (receipt?.generation === generation) {|PublishWrite skips a receipt that has rot.new"
)
sync=4166181d2ba0c169992b87f9f6fb73f0bd56657e
covered=(apps/cli/src/commands/rotate.ts apps/cli/src/commands/publish.ts apps/cli/src/publishing.ts
  packages/core/src/rotations.ts packages/core/src/plan.ts packages/core/src/state.ts)
repo="$(cd "$here/../.." && pwd)"

failed=0
for guard in "${guards[@]}"; do
  IFS='|' read -r -d '' file code action <<<"$guard" || true
  action="${action%$'\n'}"
  if ! CODE="$code" perl -0777 -ne 'exit(index($_, $ENV{CODE}) < 0 ? 1 : 0)' "$repo/$file"; then
    echo "FAIL  guard missing in $file, modeled by $action:"
    printf '%s\n' "$code" | sed 's/^/        /'
    failed=1
  fi
done
if [ $failed = 1 ]; then
  echo "      The code changed under the model. Update Rotate.tla from the code (see SKILL.md), then this list."
fi
if git -C "$repo" cat-file -e "$sync" 2>/dev/null; then
  changed="$(git -C "$repo" diff --name-only "$sync" -- "${covered[@]}")"
  if [ -n "$changed" ]; then
    echo "NOTE  covered code changed since the sync commit ${sync:0:7}; this run checks the model, not that code:"
    printf '%s\n' "$changed" | sed 's/^/        /'
  fi
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
kept="$here/out"
rm -rf "$kept"

# run DIR CONFIG RULE LABEL -> "holds", "breaks" or "error"; TLC's output goes to $work/LABEL.out
run() {
  local dir="$1" cfg="$2" rule="$3" label="$4"
  sed -E '/^INVARIANTS?/,$d' "$here/$cfg.cfg" >"$dir/$label.cfg"
  printf 'INVARIANTS\n  TypeOK\n  %s\n' "$rule" >>"$dir/$label.cfg"
  (cd "$dir" && "$java" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -deadlock \
    -metadir "$work/meta-$label" -config "$label.cfg" Rotate.tla) >"$work/$label.out" 2>&1 || true
  rm -f "$dir/$label.cfg"
  if grep -q "No error has been found" "$work/$label.out"; then
    echo holds
  elif grep -q "^Error: Invariant $rule is violated\.$" "$work/$label.out"; then
    echo breaks
  else
    echo error
  fi
}

report() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "ok    $label: $got"
  else
    mkdir -p "$kept"
    cp "$work/$label.out" "$kept/$label.out"
    echo "FAIL  $label: $got, expected $want (TLC output: verification/rotation/out/$label.out)"
    failed=1
  fi
}

for line in "${expected[@]}"; do
  read -r cfg rule want <<<"$line"
  if [ $# -gt 0 ] && [ "$1" != "$cfg" ]; then continue; fi
  report "$cfg-$rule" "$(run "$here" "$cfg" "$rule" "$cfg-$rule")" "$want"
done
[ $# -gt 0 ] && exit $failed

for mutant in "${mutants[@]}"; do
  IFS='|' read -r name replace cfg rule <<<"$mutant"
  label="mutant-$name"
  if [ "$(grep -c "\\\\\\* mutant: $name\$" "$here/Rotate.tla")" != 1 ]; then
    echo "FAIL  $label: no line of Rotate.tla is tagged \"\\* mutant: $name\" exactly once"
    failed=1
    continue
  fi
  mkdir -p "$work/$name"
  NAME="$name" REPLACE="$replace" perl -pe \
    's/^.*\\\* mutant: \Q$ENV{NAME}\E$/$ENV{REPLACE}/' "$here/Rotate.tla" >"$work/$name/Rotate.tla"
  report "$label" "$(run "$work/$name" "$cfg" "$rule" "$label")" breaks
done

exit $failed
