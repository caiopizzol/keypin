# Design: rotating AUTH_SECRET and BETTER_AUTH_SECRETS (#259)

Status: proposal, owner decisions at the end. No code yet: each option needs a change to a core contract.

## What the frameworks do

Read in source, not docs: `@auth/core` 0.41.3, `next-auth` 5.0.0-beta.32 and 4.24.15, `@auth/sveltekit`,
`@auth/express`, `@auth/qwik`, `better-auth` 1.7.25.

Auth.js

- `secret` takes a list. The first entry encrypts new session tokens; any entry decrypts.
- Core's env defaults read `AUTH_SECRET_1`..`_3` as well, but only when the config has no `secret`. The list is
  `[_3, _2, _1, AUTH_SECRET]`, so the highest number signs and `AUTH_SECRET` only decrypts.
- `next-auth` 5 sets `secret ??= AUTH_SECRET ?? NEXTAUTH_SECRET` before core runs. On Next.js, if `AUTH_SECRET` is
  set, the numbered variables are ignored. They work only with `AUTH_SECRET` unset.
- `next-auth` 4 takes one string. Changing it signs everyone out.
- With database sessions (an adapter), the cookie holds a random token looked up in the database, so a new secret
  doesn't end sessions. JWT sessions, the default, end.

Better Auth

- `BETTER_AUTH_SECRETS=2:new,1:old`: the first entry is current. Older versions still decrypt data it encrypted:
  two-factor secrets, backup codes, encrypted OAuth tokens, JWE cookie cache. That data is re-encrypted only when it's
  next written.
- The session cookie is signed with the current secret only (`getSignedCookie(..., ctx.context.secret)` in
  `api/routes/session`). So any rotation signs everyone out, list or not.
- Without the old version, data encrypted with it can't be read again. Replacing a plain `BETTER_AUTH_SECRET` does
  that to every two-factor secret.
- With `BETTER_AUTH_SECRETS` set, `BETTER_AUTH_SECRET` stays as the fallback for data from before the list.

So "keep everyone signed in" is possible only for Auth.js with JWT sessions, and only with app setup that differs by
framework. For Better Auth, the old secret protects stored data, not sessions, and dropping it can lose data.

## Why it doesn't fit today's contracts

1. `IssuerSpec.admin` is required, and `rotate` reads it. A generated secret has no admin key.
2. `Issuer.create(name)` doesn't see the current value. Better Auth needs it to add a version to the list.
3. The second `y` calls `Issuer.revoke(id)`, an API call. Dropping an old secret is a vault save and a publish.
4. The paired-key work (`idKey`) can't hold the old secret: rotate records the pair's value as `Issued.id` in
   `state.json`, and state never holds a value.

## Options

**A. Replace and sign everyone out.** Issuer kind `random`: create makes 32 random bytes (base64), keypin saves and
publishes it like any key, and there's nothing to revoke. The plan says `everyone signs in again (JWT sessions)`.
Works for any self-generated secret (`AUTH_SECRET`, `SESSION_SECRET`, `COOKIE_SECRET`), and is what you want after a
leak, since an overlap keeps forged sessions valid. Core change: an issuer without `admin` (1).

**B. Better Auth by adding a version.** Issuer kind `better-auth`, on `BETTER_AUTH_SECRETS` only: create reads the
list, prepends `<max+1>:<new>` and keeps every old version. The plan says everyone signs in again, and that keypin
keeps version N because data encrypted with it may still need it. A map with only `BETTER_AUTH_SECRET` is refused:
`Better Auth reads old secrets only from BETTER_AUTH_SECRETS. Set BETTER_AUTH_SECRETS=1:<a new secret> and keep
BETTER_AUTH_SECRET, then rotate BETTER_AUTH_SECRETS.` Core changes: (1) and (2).

**C. Auth.js overlap with two keys.** The map holds `AUTH_SECRET_2` (current) and `AUTH_SECRET_1` (previous), and the
app has no `AUTH_SECRET`, which is the only setup that works on Next.js too. Between rotations both hold the same
value, so rotate writes only `AUTH_SECRET_2`; the second `y` copies it into `AUTH_SECRET_1`, which drops the old one.
rotate refuses when the two differ: the last overlap isn't finished. keypin can't see the app's config, so it can't
tell whether the app reads the list: the plan states the setup it assumes, and the docs show it. Core changes: (1),
(3), and a new pairing that reads the previous key's value. `next-auth` 4 can't use it.

**D. Docs only.** A manual guide per framework using `keypin publish`. No code.

## Recommendation

A, then B, as two PRs. Both are honest about the sign-out, and B never loses data. C changes how the second `y`
works for one framework setup; build it only if someone on Auth.js asks to keep sessions.

## Owner decisions

1. Is "everyone signs in again", stated in the plan, an acceptable rotation (A and B)?
2. May core take changes (1) issuer without `admin` and (2) `create` sees the current value?
3. Better Auth: keypin never drops an old version, or it offers to with a warning? Recommended: never.
4. Kind names: `random` and `better-auth`, or one kind with a `format` field?
5. Build C now, later, or not at all?
