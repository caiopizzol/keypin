#!/bin/sh
# keypin's npm command: runs the binary from the @keypin/cli-<platform> package
# installed with this one, found from this file's own path. It loads no .env file.
# src/layout.ts looks in the same places, in the same order.
set -eu

self=$0
case $self in /* | ./* | ../*) ;; *) self=./$self ;; esac
while [ -L "$self" ]; do
  link=$(command readlink -- "$self")
  case $link in
    /*) self=$link ;;
    *) self=${self%/*}/$link ;;
  esac
done
keypin=$(command cd -P -- "${self%/*}/.." && command pwd -P)

case $(command uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) os= ;;
esac
case $(command uname -m) in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) arch= ;;
esac
if [ -z "$os" ] || [ -z "$arch" ]; then
  echo "keypin: keypin runs on macOS and Linux, on arm64 or x64, and this is $(command uname -s) $(command uname -m)." >&2
  exit 1
fi

for binary in \
  "$keypin/node_modules/@keypin/cli-$os-$arch/bin/keypin" \
  "$keypin/../@keypin/cli-$os-$arch/bin/keypin"; do
  if [ -f "$binary" ]; then exec "$binary" "$@"; fi
done

echo "keypin: the package @keypin/cli-$os-$arch isn't installed next to $keypin, so there's no keypin binary to run. npm installs it with keypin as an optional dependency: reinstall keypin without --omit=optional or --no-optional." >&2
exit 1
