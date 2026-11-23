# What keypin is

keypin rotates your keys at the provider that issued them and publishes them to your CI and hosting. It reads them
from the vault you already use.

## The problem

Every key has copies: in CI secrets and hosting settings, on laptops, in chats and notes. Replacing one means making
a new key, updating each copy by hand and revoking the old one, so it rarely happens.

## What keypin does

A project declares its keys in [secretspec](https://secretspec.dev)'s `secretspec.toml`: names and vaults, never
values. keypin's settings sit in the same file, under `[tool.keypin]`. From it, keypin:

- replaces a key at the provider that issued it (`keypin rotate`);
- writes production keys to CI and hosting (`keypin publish`);
- reports what a project uses and what's missing (`keypin check`);
- shows when each key is due, across your projects (`keypin status`).

It reads 1Password, Infisical, Bitwarden Secrets Manager, Doppler and AWS Secrets Manager. The
[README](../../README.md#what-is-keypin) lists every destination and issuer.

## What keypin isn't

keypin is not a vault, a secrets manager or a server, and needs no keypin account. secretspec declares the keys and
runs your app with them; keypin rotates and publishes them. keypin reads a value only while a command needs it, and
never stores one.
