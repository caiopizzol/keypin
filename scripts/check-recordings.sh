#!/bin/sh
set -eu
recordings=$(git ls-files --cached --others --exclude-standard -- '*/recordings/*')
[ -z "$recordings" ] && exit 0
status=0
writers=$(git grep -l --untracked toMatchFileSnapshot -- '*.test.ts') || status=$?
[ "$status" -gt 1 ] && exit "$status"
aside=$(mktemp -d)
moved="$aside/moved"
: > "$moved"
restore() {
  while IFS= read -r file; do
    mkdir -p "$(dirname "$file")"
    mv -f "$aside/files/$file" "$file"
  done < "$moved"
  rm -rf "$aside"
}
trap restore EXIT
printf '%s\n' "$recordings" | while IFS= read -r file; do
  [ -f "$file" ] || continue
  mkdir -p "$aside/files/$(dirname "$file")"
  mv "$file" "$aside/files/$file"
  printf '%s\n' "$file" >> "$moved"
done
if [ -n "$writers" ]; then
  set --
  while IFS= read -r writer; do set -- "$@" "$writer"; done <<EOF
$writers
EOF
  if ! env -u CI bun --bun vp test "$@" --update > "$aside/log" 2>&1; then
    cat "$aside/log" >&2
    exit 1
  fi
fi
stale=$(while IFS= read -r file; do [ -f "$file" ] || printf '%s\n' "$file"; done < "$moved")
[ -z "$stale" ] && exit 0
echo 'No test writes these recordings anymore. Delete them:' >&2
printf '%s\n' "$stale" >&2
exit 1
