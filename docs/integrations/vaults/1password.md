# 1Password

keypin reads and rotates keys in 1Password items. `check`, `status`, `publish` and `rotate` work, and
[scheduled rotation](../../guides/scheduled-rotation.md) is set up for 1Password.

## Sign in

- **Desktop app**, the default: install the 1Password desktop app and select Settings → Developer → Integrate with
  other apps. keypin reads as you, and 1Password may ask you to approve it. On Linux, install the app from the .deb
  or .rpm package; the Snap and Flatpak packages can't integrate with other apps.
- **Service account**, on a server or in CI: set `KEYPIN_1PASSWORD=service-account` and `OP_SERVICE_ACCOUNT_TOKEN`.
  See [Service accounts](../../guides/service-accounts.md).

## The provider

```toml
[project]
name = "billing"

[providers]
billing = "onepassword://Billing"

[defaults]
providers = ["billing"]

[profiles.default]
STRIPE_KEY = { description = "Stripe test key" }

[profiles.production]
STRIPE_KEY = { description = "Stripe live key", ref = { item = "stripe live", field = "credential" } }
```

The provider is `onepassword://<vault>`, with the vault's name or ID. keypin signs in to the account the 1Password
CLI uses: `OP_ACCOUNT`, else the account the app last signed the CLI in to, else the CLI's last sign-in. To name the
account, write `onepassword://<account>@<vault>`, such as `onepassword://acme.1password.com@Billing`, with the sign-in
address at the top left of the 1Password app, or an account ID. A team shares one account, and each member signs in
to it.

## Addresses

- **Without `ref`:** the item `secretspec/<project>/<profile>/<KEY>`, such as `secretspec/billing/default/STRIPE_KEY`,
  field `value`, else `password`. `secretspec set` and `secretspec import` create it.
- **With `ref`:** `item` is the item's title or ID. `field` is the field's label; without it, keypin reads `value`,
  then `password`. `section` picks a field in a section, when two fields share a label, and needs `field`. `vault`
  names a vault other than the provider's.

1Password's **Copy Secret Reference** gives `op://<vault>/<item>/<field>`; write it as
`ref = { vault = "<vault>", item = "<item>", field = "<field>" }`. keypin matches a vault, item or field by its name
or ID, ignoring case. Any field except `rotated` can hold the value; for the item's notes, use the field
`notesPlain`.

An issuer's `admin` is a 1Password secret reference, `op://<vault>/<item>/<field>`, or
`op://<vault>/<item>/<section>/<field>`, in the key's own account.

## Rotated date

Add a Date field named `rotated` to the item, with the day the value last changed. `keypin rotate` sets it to today.

## Permissions

With the desktop app, keypin reaches the vaults your 1Password user can. A service account needs read access to the
vault for `check`, `status` and `publish`, and write access for `rotate`.
