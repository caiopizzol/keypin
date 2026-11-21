import { type IssuerKind, sentence, type SignInReason, type VaultKind } from "@keypin/core";
import { AwsIssuer } from "./aws";
import {
  AUDIENCE,
  KEY_ID,
  NO_CREDENTIALS,
  NO_JOB_TOKEN,
  PROFILE,
  ROLE_ARN,
  SECRET_KEY,
} from "./credentials";
import {
  SCHEME,
  type SecretsManagerPin,
  type SecretsManagerRef,
  type SecretsManagerReference,
} from "./reference";
import { awsIssuerRules, type AwsSpec, secretsManagerVaultRules } from "./rules";
import { ROTATED_TAG } from "./secrets-manager";

export const awsIssuer: IssuerKind<AwsSpec> = {
  ...awsIssuerRules,
  connect: (_spec, admin, fetch) =>
    new AwsIssuer({ admin: async () => admin, ...(fetch === undefined ? {} : { fetch }) }),
};

export interface SecretsManagerHost {
  readonly env: Readonly<Record<string, string | undefined>>;
}

const DOCS = "docs/aws-secrets-manager.md";

export const secretsManagerVault: VaultKind<
  SecretsManagerHost,
  SecretsManagerRef,
  SecretsManagerReference,
  SecretsManagerPin
> = {
  ...secretsManagerVaultRules,
  newValueByHand: "Put a new value in the AWS secret",
  addRotatedDate: `Tag the AWS secret with ${ROTATED_TAG}<JSON key>, set to the day that key last changed as YYYY-MM-DD (${DOCS}).`,
  signInVariables: [ROLE_ARN, AUDIENCE],
  oidcVariables: [ROLE_ARN],
  addByHand: (map) => {
    const refs = map.keys.flatMap((key) =>
      Object.values(key.environments).flatMap((entry) => (entry ? [entry.ref] : [])),
    );
    return map.pins.awssm !== undefined && refs.every((ref) => ref.kind === "awssm")
      ? `create the secrets in AWS Secrets Manager and map them with ${SCHEME} references (${DOCS})`
      : undefined;
  },
  itemNotes(refs, { env }) {
    if (!refs.some((ref) => ref.kind === "awssm")) return [];
    if (env[ROLE_ARN]?.trim())
      return [`keypin signs in to AWS with GitHub Actions OIDC, as the role in ${ROLE_ARN}`];
    if (env[KEY_ID]) return [`keypin signs in to AWS with the credentials in ${KEY_ID}`];
    const profile = env[PROFILE]?.trim();
    return [`keypin signs in to AWS with the profile ${profile || "default"}`];
  },
  prerequisites({ failures }, { env }) {
    if (!failures.length) return [];
    const fix = failures.some((reason) => reason.kind === "wrong-account")
      ? `sign in to the AWS account keypin.toml pins under [awssm]`
      : env[ROLE_ARN]?.trim()
        ? oidcFix(env, failures)
        : `${NO_CREDENTIALS} (${DOCS})`;
    return [
      {
        name: "AWS",
        status: "sign-in failed",
        fix,
        title: "Sign in to AWS",
        body: [sentence(fix)],
        coversFailures: true,
      },
    ];
  },
};

function oidcFix(
  env: Readonly<Record<string, string | undefined>>,
  failures: readonly SignInReason[],
): string {
  const others = [KEY_ID, SECRET_KEY, PROFILE].filter((name) => env[name]?.trim());
  if (others.length) return `set either ${ROLE_ARN} or ${others.join(" and ")}, not both`;
  return failures.some((reason) => reason.kind === "no-credentials")
    ? NO_JOB_TOKEN
    : `check ${ROLE_ARN}, ${AUDIENCE} and the role's trust policy (${DOCS})`;
}
