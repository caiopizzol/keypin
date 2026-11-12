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

## Binary and npm packages

keypin ships as one executable with Bun inside, so it needs no Bun install or `node_modules` at run time.

```sh
cd apps/cli
bun run compile                                  # every target, into apps/cli/binaries
bun run compile darwin-arm64                     # or some of darwin-arm64, darwin-x64, linux-x64, linux-arm64
bun run check-binary binaries/keypin-darwin-arm64
bun run pack                                     # after compiling all four: the npm packages, into apps/cli/packages
```

The binary is built with Bun's `.env` and `bunfig.toml` autoload off, and it refuses to start without that build
marker. It also refuses to start while `BUN_OPTIONS`, `BUN_INSPECT` or `BUN_INSPECT_CONNECT_TO` is set, since
those still load code or a debugger into a compiled Bun program. `@1password/sdk` reads its WASM file next to its
own source, so `compile.ts` embeds that file and fails if the SDK changes how it reads it.

The variable check catches a setting left in a shell profile. It isn't a boundary: a preloaded file runs before
keypin and can unset the variable, and anyone who can set your environment can already run code as you.

On npm, `keypin` is a small package whose `keypin` command is [`launcher.sh`](../apps/cli/launcher.sh), plus one
package per platform with the binary: `@keypin/cli-darwin-arm64`, `@keypin/cli-darwin-x64`, `@keypin/cli-linux-x64`
and `@keypin/cli-linux-arm64`. `keypin` lists them as `optionalDependencies` pinned to its own version, and each
one's `os` and `cpu` (and `libc: glibc` on Linux) let the package manager install only the one that fits. npm
checks `libc` from 9.6.3. Nothing runs at install time and
nothing is downloaded at run time. `pack.ts` writes every package at the root `package.json` version, so the
platform packages move with each release.

The launcher is a POSIX `sh` script, not a Node script, because `bun add -g` and `bun x` run a Node script with Bun,
and Bun loads the folder's `bunfig.toml` preload into it. The launcher finds the binary from its own path, never
from the current folder or `PATH`, and `exec`s it with the same arguments and environment: its own variables live in
a subshell, so a caller's exported `os` or `arch` reaches keypin unchanged. It loads no `.env` file. On macOS it
tries the shell's architecture first, then the other one, since an x64 npm under Rosetta installs the x64 build on
Apple Silicon. On Linux it needs glibc's loader and says so on musl systems such as Alpine. If the platform package
is missing, it names the package and exits 1. The binary embeds the launcher's SHA-256, so
when the `keypin` on `PATH` is that launcher, the command keypin prints to approve is just `keypin`.

`check-binary` copies the binary to an empty temporary folder with a `.env` that sets `FAKE_X=leak` and a
`bunfig.toml` that preloads a file, then checks that the binary holds no path into this checkout, that `--version`,
`--help` and `status` work with empty config and state folders, that `keypin run` passes neither `FAKE_X` nor any
variable it wasn't given, that it keeps the caller's values for the names the launcher uses, that the preload never runs, and that each variable above is refused. It then packs the
npm packages around that binary, serves them from a local registry, and runs the same checks through
`npm install -g`, `bun add -g` and `bun x`, and checks the error when the platform package is missing. It never
reaches 1Password or the real npm registry. Run it on the platform the binary is for; the `check` workflow runs it
for all four targets.

## Releases

Release Please keeps a release PR open. On it, select **Approve workflows to run** so `check` runs, then merge it.
That tags the release and creates the GitHub Release. The `release` workflow then compiles each binary on its own
platform's runner and runs `check-binary` on it, packs the npm packages, and publishes the four platform packages
before `keypin`, so `keypin` never points at a version that isn't there. It skips any package version npm already
has, so a failed run can run again. npm adds provenance through trusted publishing.

The `release` workflow first checks that the four platform packages exist on npm, and fails before building
anything if one doesn't, since trusted publishing can't create a package. Before the first release that ships
them, the owner does this once:

1. On npmjs.com, create the free org `keypin` so the `@keypin` scope exists.
2. Publish a first version of each platform package by hand. After `bun run compile` and `bun run pack`, from each
   `apps/cli/packages/cli-<target>` folder: `npm publish --access public`. Publishing the version the release is
   about to ship works, and the workflow then skips it.
3. Add `release.yml` as each package's trusted publisher: `npm trust github @keypin/cli-<target> --repo
   caiopizzol/keypin --file release.yml --allow-publish` (npm 11.15 or later, account 2FA), or **Settings → Trusted
   publishing** on npmjs.com. The first publish through it must happen within 2 days.
