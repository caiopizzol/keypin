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
`bun install`: Bun 1.3 can't read `bun.lock`, so it resolves every package again and saves the lockfile in an older
format. `bun run check` fails on that format and prints the fix.

## Checks

```sh
bun run check      # format, lint and type-check
bun run test       # tests
bun run typecheck  # tsc in every package
```

## Standalone binary

keypin also builds as one executable with Bun inside, so it needs no Bun install or `node_modules` at run time.
Nothing ships it yet.

```sh
cd apps/cli
bun run compile                                  # every target, into apps/cli/binaries
bun run compile darwin-arm64                     # or some of darwin-arm64, darwin-x64, linux-x64, linux-arm64
bun run check-binary binaries/keypin-darwin-arm64
```

The binary is built with Bun's `.env` and `bunfig.toml` autoload off, and it refuses to start without that build
marker. It also refuses to start while `BUN_OPTIONS`, `BUN_INSPECT` or `BUN_INSPECT_CONNECT_TO` is set, since
those still load code or a debugger into a compiled Bun program. `@1password/sdk` reads its WASM file next to its
own source, so `compile.ts` embeds that file and fails if the SDK changes how it reads it.

The variable check catches a setting left in a shell profile. It isn't a boundary: a preloaded file runs before
keypin and can unset the variable, and anyone who can set your environment can already run code as you.

`check-binary` copies the binary to an empty temporary folder with a `.env` that sets `FAKE_X=leak`, then checks
that the binary holds no path into this checkout, that `--version`, `--help` and `status` work with empty config and
state folders, that `keypin run` doesn't pass `FAKE_X` to the command, and that each variable above is refused. It
never reaches 1Password. Run it on the platform the binary is for; the `check` workflow runs it for linux-x64.

## Releases

Release Please keeps a release PR open. On it, select **Approve workflows to run** so `check` runs, then merge it.
That tags the release, creates the GitHub Release and publishes to npm.
