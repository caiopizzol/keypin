#!/bin/sh
grep -qE '^  "lockfileVersion": 2,$' bun.lock && exit 0
echo 'bun.lock must be lockfileVersion 2, the format Bun 1.4.4 writes. A plain `bun install` on an older Bun rewrites it.' >&2
echo 'Fix: git checkout origin/main -- bun.lock && bunx --package vite-plus@1.5.1 vp install' >&2
exit 1
