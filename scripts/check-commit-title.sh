#!/bin/sh
title=$(head -n 1 "$1")
case "$title" in
  Merge\ * | Revert\ * | fixup!\ * | squash!\ * | amend!\ *) exit 0 ;;
esac
printf '%s\n' "$title" | grep -qE '^(feat|fix|docs|refactor|chore|test|perf|ci|build|style|revert)(\([a-z0-9-]+\))?!?: [^ ]' && exit 0
echo "Use a conventional title, such as: fix(cli): explain why a key is skipped" >&2
echo "Got: $title" >&2
exit 1
