#!/bin/sh
set -eu
recordings=$(find . -type f -path '*/recordings/*' -not -path '*/node_modules/*' | sort)
[ -z "$recordings" ] && exit 0
tests=$(git grep -l --untracked toMatchFileSnapshot -- '*.test.ts')
aside=$(mktemp -d)
log=$(mktemp)
restore() {
  for file in $recordings; do
    mkdir -p "$(dirname "$file")"
    mv -f "$aside/$file" "$file"
  done
  rm -rf "$aside" "$log"
}
for file in $recordings; do
  mkdir -p "$aside/$(dirname "$file")"
  mv "$file" "$aside/$file"
done
trap restore EXIT
if ! env -u CI bun --bun vp test $tests --update > "$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
stale=""
for file in $recordings; do
  [ -f "$file" ] || stale="$stale$file
"
done
[ -z "$stale" ] && exit 0
echo 'No test writes these recordings anymore. Delete them:' >&2
printf '%s' "$stale" >&2
exit 1
