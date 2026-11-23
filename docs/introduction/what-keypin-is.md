# What keypin is

keypin gets your keys out of `.env` files. It runs your apps with keys from your vault, publishes them to your CI
and hosting, and rotates them.

## The problem

Every laptop has a copy of every key in a `.env` file. More copies sit in chats, notes and commits, and nobody has
the full list.

## What keypin does

Each project lists its keys in a `keypin.toml`: names, vault references and destinations, never values. From it,
keypin:

- reports what a project uses and what's missing (`keypin check`);
- runs your app with keys from your vault (`keypin run`);
- writes production keys to CI and hosting (`keypin publish`);
- replaces a key at the provider that issued it (`keypin rotate`).

It reads 1Password, Infisical, Bitwarden, Doppler and AWS Secrets Manager. The
[README](../../README.md#what-is-keypin) lists every destination and issuer.

## What keypin isn't

keypin is not a vault, a secrets manager or a server, and needs no keypin account. It reads a value only while a
command runs, and never stores one. A command it starts still holds its keys; keypin removes the copies in files,
chats and laptops.
