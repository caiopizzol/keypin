#!/bin/sh
set -eu
git rev-parse --git-dir > /dev/null
recordings=$(git ls-files -z --cached --others --exclude-standard -- '*/recordings/*' | tr '\0' '\n')
roots=$(git ls-files -z --cached --others --exclude-standard -- '*/recordings' | tr '\0' '\n')
through_link() {
  path=$1
  while [ "$path" != . ]; do
    if [ -L "$path" ]; then return 0; fi
    path=$(dirname "$path")
  done
  return 1
}
links=$(printf '%s\n%s\n' "$roots" "$recordings" | while IFS= read -r file; do if [ -n "$file" ] && through_link "$file"; then printf '%s\n' "$file"; fi; done)
if [ -n "$links" ]; then
  echo 'Recordings must be plain files outside any symlinked folder. Fix these paths:' >&2
  printf '%s\n' "$links" >&2
  exit 1
fi
[ -z "$recordings" ] && exit 0
status=0
git grep -q --untracked toMatchFileSnapshot -- '*.test.ts' || status=$?
[ "$status" -gt 1 ] && exit "$status"
writers=$(git grep -lz --untracked toMatchFileSnapshot -- '*.test.ts' | tr '\0' '\n')
aside=$(mktemp -d)
trap 'rm -rf "$aside"' EXIT
each() {
  printf '%s\n' "$recordings" | while IFS= read -r file; do
    "$@" "$file"
  done
}
back_up() {
  [ -f "$1" ] || return 0
  mkdir -p "$aside/$(dirname "$1")"
  cp -p "$1" "$aside/$1"
}
remove() {
  [ -f "$aside/$1" ] || return 0
  rm -f "$1"
}
put_back() {
  [ -f "$aside/$1" ] || return 0
  if mkdir -p "$(dirname "$1")" && cp -p "$aside/$1" "$1" && cmp -s "$aside/$1" "$1"; then return 0; fi
  printf '%s\n' "$1"
}
stale() {
  if [ -f "$aside/$1" ] && [ ! -f "$1" ]; then printf '%s\n' "$1"; fi
}
restore() {
  code=$?
  failed=$(each put_back)
  if [ -z "$failed" ]; then
    rm -rf "$aside"
    exit "$code"
  fi
  echo "Couldn't put these recordings back. The originals are in $aside:" >&2
  printf '%s\n' "$failed" >&2
  exit 1
}
each back_up
trap restore EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
each remove
if [ -n "$writers" ]; then
  set --
  while IFS= read -r writer; do set -- "$@" "$writer"; done <<EOF
$writers
EOF
  if ! env -u CI bun --bun vp test "$@" --update > "$aside/.log" 2>&1; then
    cat "$aside/.log" >&2
    exit 1
  fi
fi
found=$(each stale)
[ -z "$found" ] && exit 0
echo 'No test writes these recordings anymore. Delete them:' >&2
printf '%s\n' "$found" >&2
exit 1
