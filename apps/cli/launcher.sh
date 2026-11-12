#!/bin/sh
# keypin's npm command: runs the binary from the @keypin/cli-<platform> package
# installed with this one, found from this file's own path. It loads no .env file.
# src/layout.ts looks in the same places, in the same order.
# find_binary runs in a $(...) subshell, so the names it sets never reach keypin's
# environment, even when the caller exported one of them.
set -eu

find_binary() {
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
    return 1
  fi

  # An x64 npm under Rosetta installs the x64 build on Apple Silicon, so macOS
  # tries this shell's architecture first, then the other one.
  if [ "$os" = darwin ]; then
    case $arch in
      arm64) cpus="arm64 x64" ;;
      *) cpus="x64 arm64" ;;
    esac
  else
    cpus=$arch
    case $arch in
      x64) loader=/lib64/ld-linux-x86-64.so.2 ;;
      *) loader=/lib/ld-linux-aarch64.so.1 ;;
    esac
    if [ ! -e "$loader" ]; then
      echo "keypin: keypin's Linux build needs glibc, and this system has no $loader. musl systems such as Alpine aren't supported." >&2
      return 1
    fi
  fi

  for cpu in $cpus; do
    for binary in \
      "$keypin/node_modules/@keypin/cli-$os-$cpu/bin/keypin" \
      "$keypin/../@keypin/cli-$os-$cpu/bin/keypin"; do
      if [ -f "$binary" ]; then
        printf '%s\n' "$binary"
        return 0
      fi
    done
  done

  echo "keypin: the package @keypin/cli-$os-$arch isn't installed next to $keypin, so there's no keypin binary to run. npm installs it with keypin as an optional dependency: reinstall keypin without --omit=optional or --no-optional." >&2
  return 1
}

set -- "$(find_binary)" "$@"
[ -n "$1" ] || exit 1
exec "$@"
