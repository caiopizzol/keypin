# Development

## Install from source

You need git, [Bun](https://bun.sh) and [Node](https://nodejs.org) 22.18 or newer. The commands below fetch Bun
1.4.4 themselves, and the installer runs on Node.

```sh
git clone https://github.com/caiopizzol/keypin.git ~/keypin
cd ~/keypin
bunx --package vite-plus@1.5.1 vp install
alias keypin='bunx bun@1.4.4 --no-env-file ~/keypin/apps/cli/src/main.ts'
```

Add the alias to your shell profile. Package scripts don't load aliases, so call
`bunx bun@1.4.4 --no-env-file ~/keypin/apps/cli/src/main.ts` in full there.

Run the install command again after every `git pull`, or keypin can't find its own packages. Never run a plain
`bun install`: Bun 1.3 rewrites `bun.lock` in an older format.

## Checks

```sh
bun run check      # format, lint and type-check
bun run test       # tests
bun run typecheck  # tsc in every package
```

## Releases

Release Please keeps a release PR open. On it, select **Approve workflows to run** so `check` runs, then merge it.
That tags the release, creates the GitHub Release and publishes to npm.
