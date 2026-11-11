# Discover

`keypin discover` lists every key name a project uses and where it's set, reports problems, and prints a draft
`keypin.toml` for the names that aren't mapped yet. It only reads, and never prints a value.

```sh
keypin discover [folder] [--json]   # the current folder by default
```

## What it reads

- **Env files:** names from `.env*` and `.dev.vars*`. Names in `.example`, `.sample` and `.template` files are
  expected, not set. Dependency and build folders, and nested git repositories, are skipped.
- **Wrangler config:** each Worker's name, `account_id`, `secrets.required` and `vars` names.
- **Workflows:** every `secrets.NAME` and `vars.NAME` they reference.
- **GitHub:** the Actions secrets of the `origin` repo, through the `gh` login in `git config github.account`, or
  else the repo's owner.
- **Cloudflare:** each Worker's secrets, through the `wrangler` login, only when it reaches the config's
  `account_id`. discover doesn't guess an account.
- **`keypin.toml`:** names it already maps are marked `mapped`.

Each name is `local`, `cloud`, `local and cloud`, or `declared, not set`. `plain variable` means it's only under
wrangler `vars`, which hold plain values, not secrets. `cloud unknown` means a cloud read wasn't possible.

## Problems

- An env file tracked by git, so its values may be committed.
- A workflow references a secret the repo doesn't have. Environment and organization secrets aren't read, so it may be
  set there.
- A repo secret no workflow here references. A reusable workflow or `secrets: inherit` can hide a use, so this means
  "not referenced here", not "unused".
- A `secrets.required` name that isn't set on the Worker.

When a read isn't possible, discover says what and why. Unknown never means none.

## The draft

The draft adds a `dev` entry for each unmapped name set locally, and a `prod` entry with every repo and Worker where
it was found. The `op://` references are placeholders: replace each with the field's secret reference from 1Password. If the
project has a `keypin.toml`, copy only the `[keys.*]` tables into it.
