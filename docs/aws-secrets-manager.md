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

## Pulling in GitHub Actions

A GitHub Actions job can sign in to AWS with OIDC and read a key itself, so the repo stores no copy. List the job
in the map with a [`pull`](configuration.md#pulling-in-ci) entry, then:

1. Add GitHub as an identity provider, once per AWS account:

   ```sh
   aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   ```

2. Create a role that only your repo's branch can assume. Its policy needs only `secretsmanager:GetSecretValue` on
   the secret, plus `kms:Decrypt` if the secret uses your own KMS key. The trust policy's condition names the branch:

   ```json
   "Condition": {
     "StringEquals": {
       "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
       "token.actions.githubusercontent.com:sub": "repo:owner@123456/repo@456789:ref:refs/heads/main"
     }
   }
   ```

   Use the subject format your repo uses. Repos created after July 15, 2026, and older repos that opted in or were
   renamed or transferred since, include the owner and repo IDs, which
   `gh api repos/owner/repo --jq '"\(.owner.id) \(.id)"'` prints. Other repos use `repo:owner/repo:ref:refs/heads/main`.
   A job with a GitHub `environment` gets an `environment:<name>` subject instead of the branch, so match that and
   limit the branch with the environment's deployment rules. See
   [GitHub's subject formats](https://docs.github.com/en/actions/reference/security/oidc).

3. Sign the job in, then run keypin:

   ```yaml
   permissions:
     id-token: write
     contents: read
   steps:
     - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
     - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
       with:
         node-version: 24
     - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
       with:
         role-to-assume: arn:aws:iam::123456789012:role/my-role
         aws-region: eu-west-1
     - run: npm install -g keypin
     - run: keypin run --env prod --only STRIPE_KEY -- <command>
   ```

A job on another branch can't assume the role. A value you change in Secrets Manager reaches the jobs without
`publish`, once Secrets Manager returns the new version.
