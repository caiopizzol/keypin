# 1Password

keypin reads a field of a 1Password item, or the item's notes. Every command works with 1Password. `import` creates
items only in 1Password, and [scheduled rotation](../../guides/scheduled-rotation.md) supports only 1Password for
now.

## Sign in

- **Desktop app**, the default: install the 1Password desktop app and select Settings → Developer → Integrate with
  other apps. keypin reads as you, and 1Password may ask you to approve it. On Linux, install the app from the .deb
  or .rpm package; the Snap and Flatpak packages can't integrate with other apps.
- **Service account**, on a server or in CI: set `KEYPIN_1PASSWORD=service-account` and `OP_SERVICE_ACCOUNT_TOKEN`.
  See [Service accounts](../../guides/service-accounts.md).

## The map

```toml
[1password]
account = "my.1password.com"

[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "op://Private/billing dev stripe key/credential"
```

`account` is the account's sign-in address, such as `my.1password.com`, its name as shown at the top left of the
1Password app, or its account ID. A team shares one account, and each member signs in to it.

## References

A reference is `op://<vault>/<item>/<field>`, or `op://<vault>/<item>/<section>/<field>` when two fields share a
name. In 1Password, open the field's menu and select **Copy Secret Reference**. keypin matches a vault, item or field
by its name or ID, ignoring case, and refuses a name that two of them share.

Any field except `rotated` can hold the value, such as `password` or an API Credential's `credential`. For the item's
notes, use the field `notesPlain`. keypin doesn't read one-time passwords, files or empty values.

## Rotated date

Add a Date field named `rotated` to the item, with the day the value last changed. `keypin status` adds
`rotate_every` to it to show when the key is due. `keypin rotate` and `keypin import` set it to today.

## Permissions

With the desktop app, keypin reaches the vaults your 1Password user can. A service account needs read access to
the vault for `run`, `check`, `status` and `publish`, and write access for `rotate` and `import`.

## Pulling in GitHub Actions

A job signs in with a service account. Save its token as an Actions secret, list the job in the map with a
[`pull`](../../guides/publishing.md#pulling-in-ci) entry, and run:

```yaml
- run: keypin run --env prod --only STRIPE_KEY -- <command>
  env:
    KEYPIN_1PASSWORD: service-account
    OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
```

The repo stores the token instead of each key. Add `OP_SERVICE_ACCOUNT_TOKEN` to
[`ignore`](../../reference/keypin-toml.md#ignored-keys), or `keypin check` asks you to map it.
