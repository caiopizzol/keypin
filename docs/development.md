# Development

You need git, [Bun](https://bun.sh) and [Node](https://nodejs.org) 22.18 or newer.

```sh
git clone https://github.com/caiopizzol/keypin.git ~/keypin
cd ~/keypin
bunx --package vite-plus@1.5.1 vp install
alias keypin='bunx bun@1.4.4 --no-env-file ~/keypin/apps/cli/src/main.ts'
```

Run the install command again after each `git pull`. Don't run a plain `bun install`: older Bun rewrites
`bun.lock` in a format `bun run check` rejects.

## Checks

```sh
bun run check      # format, lint and type-check
bun run test       # tests
bun run typecheck  # tsc in every package
```

## Binary and npm packages

keypin ships as one executable with Bun inside.

```sh
cd apps/cli
bun run compile darwin-arm64     # or darwin-x64, linux-x64, linux-arm64; no target builds all four
bun run check-binary binaries/keypin-darwin-arm64
bun run pack                     # after compiling all four: the npm packages, into apps/cli/packages
```

The binary is built with Bun's `.env` and `bunfig.toml` loading off, and refuses to start while `BUN_OPTIONS`,
`BUN_INSPECT` or `BUN_INSPECT_CONNECT_TO` is set. That check catches a setting left in a shell profile. It isn't a
boundary: anyone who can set your environment can already run code as you.

On npm, `keypin` is a small package whose command is [`launcher.sh`](../apps/cli/launcher.sh), plus one package per
platform, `@keypin/cli-<os>-<cpu>`, as optional dependencies pinned to its version. The launcher finds the binary
next to itself and runs it with the same arguments and environment; it loads no `.env` file.

`check-binary` runs the binary, and then the installed npm packages, in an empty folder with a `.env` and a
`bunfig.toml` preload, and checks that `keypin run` passes no variable it wasn't given. Run it on the platform the
binary is for; the `check` workflow runs it for all four.

## Releases

Release Please keeps a release PR open. Approve its workflows so `check` runs, then merge it. The `release` workflow
then builds and checks each binary, and publishes the four platform packages before `keypin`.

The workflow fails before building if a platform package doesn't exist on npm yet, since trusted publishing can't
create one. Before the first release, the owner does this once:

1. On npmjs.com, create the free org `keypin`.
2. Publish a placeholder of each platform package so it exists: after `bun run compile` and `bun run pack`, in each
   `apps/cli/packages/cli-<target>` folder set `"version"` to `0.0.0-bootstrap` in `package.json`, then run
   `npm publish --access public --tag bootstrap`. Don't publish the version the release will ship: the workflow
   skips a version npm already has, so trusted publishing would never be used.
3. Make `release.yml` each package's trusted publisher: `npm trust github @keypin/cli-<target> --repo
   caiopizzol/keypin --file release.yml --allow-publish` (npm 11.15 or later, with 2FA). Then merge the release PR
   within 2 days, or the trusted publisher expires.
