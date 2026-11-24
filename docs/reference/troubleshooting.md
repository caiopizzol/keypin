# Troubleshooting

Fixes for problems that keypin's errors don't cover.

## `wrangler dev`

`wrangler dev` gives the Worker an environment variable only when its name is in the config's `secrets.required`,
and only when there's no `.dev.vars` file. To use the keys from your vault:

1. List each secret under `secrets.required` in the wrangler config.
2. Move the secrets in `.dev.vars` to your vault, then delete the file. Pass a plain setting with `wrangler dev --var
   NAME:value`, never a secret: the value would show in the process list and shell history.
3. Run `secretspec run -- wrangler dev`.

## Signing in to Cloudflare

keypin signs in to Cloudflare one of two ways:

- **`wrangler login`:** needs wrangler 4.57.0 or later. keypin runs the project's wrangler, else the one on `PATH`.
- **API token:** set `KEYPIN_CLOUDFLARE_API_TOKEN` to a token with the
  [Workers role](https://developers.cloudflare.com/workers/authorization/workers/) Editor, which older tokens call
  Workers Scripts Edit. keypin then doesn't run wrangler.

keypin never signs in with `CLOUDFLARE_API_TOKEN`: that stays a key `secretspec.toml` can declare.
