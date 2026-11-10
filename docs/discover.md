# Discover

`keypin discover` lists every key name a project uses and where each one is set: in local files, in GitHub Actions
secrets, or in Cloudflare Worker secrets. It reports problems, and prints a draft `keypin.toml` for the names that
aren't mapped yet.

```sh
keypin discover [folder] [--json]   # the current folder by default
```

It only reads. It never reads a value from GitHub or Cloudflare, never prints one, never writes a file, never reads
the vault, and never runs project code.

## What it reads

| Source           | What it takes                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Local files      | Names from `.env`, `.env.*`, `.dev.vars` and `.dev.vars.*`, anywhere in the folder. Everything after `=` is dropped. |
| Example files    | Names from files ending in `.example`, `.sample` or `.template`, reported as expected, not set.                      |
| `wrangler.*`     | Each Worker's name, `account_id`, `secrets.required` and the names under `vars`, including `[env.*]`.                |
| GitHub workflows | Every `secrets.NAME` and `vars.NAME` in `${{ }}` expressions and `if:` conditions. Comments are ignored.             |
| GitHub           | The repo's Actions secret names and when each was updated, for the repo in `git remote get-url origin`.              |
| Cloudflare       | The secret names of each Worker the wrangler config names, in its `account_id`.                                      |
| `keypin.toml`    | The names it already maps.                                                                                           |

It skips dependency, build and cache folders such as `node_modules`, `.git`, `.wrangler` and `dist`, and any
folder that is its own git repository. Run `discover` in that folder instead.

**Logins.** For GitHub, it uses the `gh` login named in `git config github.account`, or else the repo's owner. For
Cloudflare, it uses the `wrangler` login, and reads a Worker only when that login reaches the config's `account_id`.

## Where a name is set

| Label               | Meaning                                                         |
| ------------------- | --------------------------------------------------------------- |
| `local`             | in a local env file                                             |
| `cloud`             | a GitHub Actions secret or a Worker secret                      |
| `local and cloud`   | both                                                            |
| `declared, not set` | only an example file, a workflow or `secrets.required` names it |
| `plain variable`    | only under `vars`, which holds plain values, not secrets        |
| `cloud unknown`     | a cloud read wasn't possible, so it may be set there too        |
| `mapped`            | this project's `keypin.toml` has a key with this `env`          |

## Problems

- An env file tracked by git, so its values may be committed.
- A workflow references a secret that the repo doesn't have. Environment and organization secrets aren't read, so
  the secret may be set there.
- A repo secret that no workflow in this repo references. A reusable workflow or `secrets: inherit` can hide a use,
  so this means "not referenced here", not "unused".
- A name in `secrets.required` that isn't set on the Worker.

## Unknown

When a read isn't possible, `discover` says what it couldn't read and why. For example, the folder has no GitHub
remote, the login gets HTTP 403, the wrangler config has no `account_id`, or the login reaches another Cloudflare
account. Unknown never means none. `discover` doesn't guess an account.

## The draft

The draft holds one key for each name that is set and not mapped:

- a `dev` entry when the name is set in a local file;
- a `prod` entry with every GitHub repo and Worker where it was found.

The vault item names are placeholders such as `my-project prod stripe key`. Create items with those names, or change
them. If the project has a `keypin.toml`, the draft uses its first vault. Copy only the `[keys.*]` tables into it.
`discover` checks that the draft parses before printing it, and never writes it.

`--json` gives the same report, including the draft, for scripts and agents. Neither format holds a value.
