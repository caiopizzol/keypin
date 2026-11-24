# What keypin is

When a key has to change, keypin replaces it at the provider and everywhere the project publishes it. `keypin status`
shows what's due across all your projects.

## The problem

Every key has copies, in the CI secrets and hosting settings of each project that uses it. Replacing one by hand
rarely happens, and a copy you miss breaks once the old key is revoked.

## When you need it

- **A key may have leaked.** `keypin rotate` makes a new key, publishes it to every destination the project lists,
  then asks before it revokes the old one.
- **A key is due.** `rotate_every` says how often. `keypin rotate --due` rotates each due key with an `issuer`, by
  hand or on a schedule in your GitHub Actions.
- **Many repos, many keys.** `keypin status` lists every project's keys and when each is due. The
  [console](https://keypin.dev/console/) shows what's overdue in each repo you share.
- **Someone left the team.** Rotate the keys they could read.
- **An auditor asks.** Each key's rotated date sits on its vault item, and a scheduled run commits what it did to
  `.keypin/`, without values.

## What keypin does

A project declares its keys in [secretspec](https://secretspec.dev)'s `secretspec.toml`, and keypin's settings sit in
the same file, under `[tool.keypin]`. From it, keypin:

- replaces a key at the provider that issued it, and publishes the new one (`keypin rotate`);
- shows when each key is due, across your projects (`keypin status`);
- writes keys to CI and hosting (`keypin publish`);
- reports what a project uses and what's missing (`keypin check`).

keypin writes only to the destinations `secretspec.toml` lists for the key; it doesn't find other copies, including
another project's. The [README](../../README.md#what-is-keypin) lists every issuer, destination and vault.

## What keypin isn't

keypin is not a vault, a secrets manager or a server, and needs no keypin account. It reads a value only while a
command needs it, and never stores one.
