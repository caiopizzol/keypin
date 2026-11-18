# AWS Secrets Manager

keypin can read keys from [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/) instead of 1Password.
`run`, `check`, `publish` and `rotate` work. keypin doesn't create secrets, so `import` doesn't work; create them
with `aws secretsmanager create-secret`.

1. Pin your account ID in `keypin.toml`, and reference each secret by region and name. Add `:<key>` to read one
   key of a JSON secret:

   ```toml
   [awssm]
   account = "123456789012"
   
   [keys.STRIPE_KEY]
   rotate_every = "90d"
   dev = "awssm://eu-west-1/billing/dev:STRIPE_KEY"
   prod = "awssm://eu-west-1/billing/prod/stripe"
   ```

   `account` is the 12-digit ID that `aws sts get-caller-identity` shows.

2. Sign in the way the AWS CLI does: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_SESSION_TOKEN` for
   temporary credentials, or a profile with keys in `~/.aws/credentials`, chosen with `AWS_PROFILE`. keypin doesn't
   sign in with SSO, `credential_process` or role profiles itself. For those, export the profile's temporary
   credentials first:

   ```sh
   eval "$(aws configure export-credentials --profile work --format env)"
   ```

Before it reads, keypin checks that the credentials belong to the pinned account and refuses another. `keypin run`
passes your AWS variables to the command, since apps often use them too.

`keypin rotate` saves a new version with `PutSecretValue`, and keeps a JSON secret's other keys. It refuses a secret
that Secrets Manager rotates itself or that another AWS service manages.

## Rotated date

For a whole secret, the rotated date is the day its current version was made. For one key of a JSON secret, it's a
tag on the secret, `keypin-rotated:<key>`, with a `YYYY-MM-DD` date. `keypin rotate` sets the tag; add it yourself
for a key you rotated by hand.

## Permissions

keypin needs `secretsmanager:GetSecretValue`, `DescribeSecret` and `ListSecretVersionIds` to read, and
`PutSecretValue` and `TagResource` to rotate, plus `kms:Decrypt` and `kms:GenerateDataKey` on the secret's key if
it isn't the AWS managed one.
