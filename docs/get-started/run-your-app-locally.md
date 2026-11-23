# Run your app locally

secretspec moves the keys in your `.env` into your vault and runs your app with them. keypin isn't part of this step.

## Move your keys

Once `secretspec.toml` names your vault, copy the values of the keys `secretspec init` declared:

```sh
secretspec import dotenv:.env
```

It copies the value of each declared key into your vault, such as the 1Password item
`secretspec/billing/default/DATABASE_URL`, and never changes `.env`: remove the lines it imported, or delete the file
when nothing else is in it. For a key you add to `.env` later, `keypin check` prints the commands to declare and
import it.
[Moving off env files](../guides/moving-off-env-files.md) covers the rest.

## Run your app

```sh
secretspec run -- npm run dev
```

`secretspec run` starts the command with the `default` profile's keys as environment variables. For `wrangler dev`, see
[Troubleshooting](../reference/troubleshooting.md#wrangler-dev).
