# What keypin is

keypin gets your keys out of `.env` files. It runs your apps with keys from your vault, publishes them to your CI
and hosting, and rotates them.

## The problem with .env files

Every laptop has a copy of every key in a `.env` file. More copies sit in chats, notes and commits, and nobody has
the full list. A coding agent creates a provider key in minutes, so keys pile up in files and dashboards faster
than anyone tracks them.

## What keypin does

Each project lists its keys in a `keypin.toml`: names, vault items and destinations, never values. From that map,
keypin:

- reports what a project uses and what's missing (`keypin check`);
- runs your app with the keys from your vault (`keypin run`);
- writes each production key to the places that need it, such as GitHub Actions or a Cloudflare Worker
  (`keypin publish`);
- replaces a key at the provider that issued it, then publishes the new one (`keypin rotate`);
- shows when each key is due for rotation (`keypin status`).

It reads keys from 1Password, Infisical, Bitwarden Secrets Manager, Doppler and AWS Secrets Manager. The
[README](../../README.md#what-is-keypin) lists every destination and issuer.

## What keypin isn't

keypin is not a vault, a secrets manager or a server. Your vault holds the values, your destinations receive them,
and keypin knows the path between them. The CLI needs no keypin account and no keypin server.

The hosted [console](https://keypin.dev/console/) is optional. It reads `keypin.toml`, workflow files, and secret
names and dates, never a value.

## What keypin never stores

Values stay in your vault and in the destinations you list. keypin reads a value only while a command runs or a
publish writes it, and keeps no copy: `keypin.toml` and the files keypin keeps on your machine hold names and
places, never values. See [Files and state](../reference/files-and-state.md).

A command that `keypin run` starts still holds its keys while it runs. keypin removes the copies in files, chats
and laptops; it can't stop a running program from leaking what it reads.
