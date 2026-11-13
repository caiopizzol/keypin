#!/bin/sh
found=$(git ls-files --cached --others --exclude-standard -- '*.js' '*.mjs' '*.cjs' '*.jsx')
[ -z "$found" ] && exit 0
echo 'This repo is TypeScript only. Rename these to .ts or .tsx:' >&2
echo "$found" >&2
exit 1
