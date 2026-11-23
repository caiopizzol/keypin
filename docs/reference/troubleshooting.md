# Troubleshooting

## `wrangler dev`

`wrangler dev` gives the Worker an environment variable only when its name is in the config's `secrets.required`,
and only when there's no `.dev.vars` file. To use keypin's keys:

1. List each secret under `secrets.required` in the wrangler config.
2. Import the secrets in `.dev.vars`, then delete the file. Pass a plain setting with `wrangler dev --var
   NAME:value`, never a secret: the value would show in the process list and shell history.
3. Run `keypin run -- wrangler dev`.

## Signing in to Cloudflare

keypin signs in to Cloudflare one of two ways:

- **`wrangler login`:** keypin asks `wrangler auth token` (wrangler 4.57.0 or later) for the login, so a login in the
  system keyring works, and wrangler refreshes an expired one, even for `keypin check`. It runs the project's wrangler, else the one on
  `PATH`. Not on Windows yet.
- **API token:** set `KEYPIN_CLOUDFLARE_API_TOKEN` to a token that can edit the Worker's scripts. keypin then doesn't
  run wrangler, and `keypin run` doesn't pass the variable to a command.

keypin never signs in with `CLOUDFLARE_API_TOKEN`: that stays a key your map can hold.
