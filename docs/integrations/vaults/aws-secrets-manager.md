# AWS Secrets Manager

keypin reads and rotates keys in [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/), whole secrets or one
key of a JSON secret. `check`, `status`, `publish` and `rotate` work. keypin doesn't create secrets: save each value
with `secretspec set` first.

## Sign in

keypin signs in the way the AWS CLI does: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_SESSION_TOKEN`
for temporary credentials, or a profile with keys in `~/.aws/credentials`, chosen with `AWS_PROFILE`. It doesn't
sign in with SSO, `credential_process` or role profiles itself; export their temporary credentials first:

```sh
eval "$(aws configure export-credentials --profile work --format env)"
```

In GitHub Actions, keypin can sign in with OIDC instead; see
[Signing in from GitHub Actions](#signing-in-from-github-actions).

## The provider

```toml
[project]
name = "billing"

[providers]
aws = "awssm://us-east-1?prefix=acme"

[defaults]
providers = ["aws"]

[profiles.production]
STRIPE_KEY = { description = "Stripe" }
DB_PASSWORD = { description = "Database password", ref = { item = "prod/db-credentials", field = "password" } }
```

The provider is `awssm://<region>`, with an optional `?prefix=<prefix>` for the secrets secretspec names. Write the
region: CI and the console can't see the one secretspec would take from your environment. Set `AWS_PROFILE` where
keypin runs instead of a `<profile>@` in the URI. keypin ignores `kms_key_id` and `tag.*`, which apply only when
secretspec creates a secret.

## Addresses

- **Without `ref`:** the whole secret `[<prefix>/]secretspec/<project>/<profile>/<KEY>`. In the example, `STRIPE_KEY`
  is `acme/secretspec/billing/production/STRIPE_KEY`.
- **With `ref`:** `item` is the secret's name, and `field` reads one key of a JSON secret. keypin rotates it in
  place, though secretspec only reads it. Write the name, not an ARN, without the 6-character suffix.

An issuer's `admin` is a reference in keypin's own syntax, not a provider URI: `awssm://<region>/<secret name>`, with
`:<key>` after the name to read one key of a JSON secret.

## Rotated date

For a whole secret, it's the day its current version was made, so a `secretspec set` counts too. For one key of a
JSON secret, it's the tag `keypin-rotated:<key>` on the secret, as `YYYY-MM-DD`. `keypin rotate` sets the tag and
keeps the secret's other keys; add the tag yourself for a key you rotated by hand.

## Permissions

keypin needs `secretsmanager:GetSecretValue`, `DescribeSecret` and `ListSecretVersionIds` to read, and
`PutSecretValue` and `TagResource` to rotate, plus `kms:Decrypt` and `kms:GenerateDataKey` on the secret's key if
it isn't the AWS managed one.

## Signing in from GitHub Actions

A job, such as [scheduled rotation](../../guides/scheduled-rotation.md), can sign in with OIDC, so the repo stores no
AWS keys:

1. Add GitHub as an identity provider, once per AWS account:

   ```sh
   aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   ```

2. Create a role that only your repo's branch can assume, with the permissions above. Its trust policy names the
   branch:

   ```json
   "Condition": {
     "StringEquals": {
       "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
       "token.actions.githubusercontent.com:sub": "repo:owner@123456/repo@456789:ref:refs/heads/main"
     }
   }
   ```

   Repos created after July 15, 2026, and older repos that opted in or were renamed or transferred since, include
   the owner and repo IDs, which `gh api repos/owner/repo --jq '"\(.owner.id) \(.id)"'` prints. Other repos use
   `repo:owner/repo:ref:refs/heads/main`. For a job with a GitHub `environment`, replace `:ref:refs/heads/main` with
   `:environment:<name>`, and limit the branch with the environment's deployment rules. See
   [GitHub's subject formats](https://docs.github.com/en/actions/reference/security/oidc).

3. Give the job `permissions: id-token: write`, and set `KEYPIN_AWS_ROLE_ARN` to the role's ARN, with the other AWS
   variables unset. keypin exchanges GitHub's token for 15-minute credentials that only keypin uses.

Set `KEYPIN_AWS_AUDIENCE` for another audience, and add it to both the trust policy and the identity provider
(`aws iam add-client-id-to-open-id-connect-provider`). If other steps need AWS credentials too, sign the job in with
[`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials) and leave
`KEYPIN_AWS_ROLE_ARN` unset.

## Limits

- `keypin rotate` refuses a secret that Secrets Manager rotates itself or that another AWS service manages.
- keypin doesn't read binary secrets.
