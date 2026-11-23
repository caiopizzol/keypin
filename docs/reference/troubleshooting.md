# Troubleshooting

## `wrangler dev`

`wrangler dev` gives the Worker an environment variable only when its name is in the config's `secrets.required`,
and only when there's no `.dev.vars` file. To use the keys from your vault:

1. List each secret under `secrets.required` in the wrangler config.
2. Move the secrets in `.dev.vars` to your vault, then delete the file. Pass a plain setting with `wrangler dev --var
   NAME:value`, never a secret: the value would show in the process list and shell history.
3. Run `secretspec run -- wrangler dev`.

## Signing in to Cloudflare

keypin signs in to Cloudflare one of two ways:

- **`wrangler login`:** keypin asks `wrangler auth token` (wrangler 4.57.0 or later) for the login, so a login in the
  system keyring works, and wrangler refreshes an expired one, even for `keypin check`. It runs the project's wrangler, else the one on
  `PATH`. Not on Windows yet.
- **API token:** set `KEYPIN_CLOUDFLARE_API_TOKEN` to a token with the
  [Workers role](https://developers.cloudflare.com/workers/authorization/workers/) Editor, which older tokens call
  Workers Scripts Edit. keypin then doesn't run wrangler.

keypin never signs in with `CLOUDFLARE_API_TOKEN`: that stays a key `secretspec.toml` can declare.

## No item in a profile

Each secretspec profile has its own vault items, so importing `.env` fills only `default`. When `keypin check` says
`No item` for a key in another profile, such as `production`, it prints the command that saves it:
`SECRETSPEC_PROFILE=production secretspec import dotenv:.env.production` when that file sets the key, otherwise
`secretspec set <KEY> --profile production`.

## The service account no longer exists

Someone deleted the service account in `OP_SERVICE_ACCOUNT_TOKEN`. Make a new one as in
[Scheduled rotation](../guides/scheduled-rotation.md#setup), and replace the token wherever it's set.
