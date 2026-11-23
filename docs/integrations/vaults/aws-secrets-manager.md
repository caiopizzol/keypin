# AWS Secrets Manager

keypin reads secrets from [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/), whole or one key of a JSON
secret. `run`, `check`, `status`, `publish` and `rotate` work; `import` creates 1Password items, so create the secrets
with `aws secretsmanager create-secret`.

## Sign in

keypin signs in the way the AWS CLI does: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_SESSION_TOKEN`
for temporary credentials, or a profile with keys in `~/.aws/credentials`, chosen with `AWS_PROFILE`. It doesn't
sign in with SSO, `credential_process` or role profiles itself; export their temporary credentials first:

```sh
eval "$(aws configure export-credentials --profile work --format env)"
```

In GitHub Actions, keypin can sign in with OIDC instead; see [Pulling in GitHub Actions](#pulling-in-github-actions).
keypin checks that the credentials belong to the pinned account. `keypin run` passes your AWS variables to the
command, since apps often use them too.

## The map

```toml
[awssm]
account = "123456789012"

[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "awssm://eu-west-1/billing/dev:STRIPE_KEY"
```

`account` is the 12-digit ID that `aws sts get-caller-identity` shows.

## References

A reference is `awssm://<region>/<secret name>`, such as `awssm://eu-west-1/billing/prod/stripe`. Add `:<key>` to read
one key of a JSON secret, as in the map above. keypin reads a secret by name, not by ARN.

## Rotated date

For a whole secret, it's the day its current version was made. For one key of a JSON secret, it's the tag
`keypin-rotated:<key>` on the secret, as `YYYY-MM-DD`. `keypin rotate` sets the tag and keeps the secret's other keys;
add the tag yourself for a key you rotated by hand.

## Permissions

keypin needs `secretsmanager:GetSecretValue`, `DescribeSecret` and `ListSecretVersionIds` to read, and
`PutSecretValue` and `TagResource` to rotate, plus `kms:Decrypt` and `kms:GenerateDataKey` on the secret's key if
it isn't the AWS managed one.

## Pulling in GitHub Actions

A job can sign in with OIDC and read a key itself, so the repo stores no copy. List the job in the map with a
[`pull`](../../guides/publishing.md#pulling-in-ci) entry, then:

1. Add GitHub as an identity provider, once per AWS account:

   ```sh
   aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   ```

2. Create a role that only your repo's branch can assume, with `secretsmanager:GetSecretValue` on the secret, plus
   `kms:Decrypt` for your own KMS key. Its trust policy names the branch:

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

3. In the job, give keypin the role's ARN. keypin exchanges GitHub's token for 15-minute credentials, which only
   keypin uses, never the command:

   ```yaml
   permissions:
     id-token: write
     contents: read
   steps:
     - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
     - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
       with:
         node-version: 24
     - run: npm install -g keypin
     - run: keypin run --env prod --only STRIPE_KEY -- <command>
       env:
         KEYPIN_AWS_ROLE_ARN: arn:aws:iam::123456789012:role/my-role
   ```

   If other steps need AWS credentials too, sign the job in with
   [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials) and leave
   `KEYPIN_AWS_ROLE_ARN` unset.

## Limits

- `keypin rotate` refuses a secret that Secrets Manager rotates itself or that another AWS service manages.
- keypin doesn't read binary secrets.
