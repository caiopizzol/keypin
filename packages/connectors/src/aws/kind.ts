import { type IssuerKind, type IssuerSpec, sentence, type VaultKind } from "@keypin/core";
import { AwsIssuer } from "./aws";
import { KEY_ID, NO_CREDENTIALS, PROFILE } from "./credentials";
import {
  account,
  decode,
  format,
  parse,
  readPin,
  SCHEME,
  type SecretsManagerPin,
  type SecretsManagerRef,
  type SecretsManagerReference,
} from "./reference";
import { ROTATED_TAG } from "./secrets-manager";

export interface AwsSpec extends IssuerSpec {
  readonly kind: "aws";
  readonly keyId: string;
}

export const awsIssuer: IssuerKind<AwsSpec> = {
  kind: "aws",
  parse(read) {
    read.only(["key_id"]);
    const admin = read.admin();
    const keyId = read.idKey();
    return admin && keyId ? { kind: "aws", admin, keyId } : undefined;
  },
  connect: (_spec, admin, fetch) =>
    new AwsIssuer({ admin: async () => admin, ...(fetch === undefined ? {} : { fetch }) }),
  idKey: (spec) => spec.keyId,
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
  kind: "awssm",
  name: "AWS Secrets Manager",
  scheme: SCHEME,
  placeholder: "the secret's region and name",
  needsPin: `needs your AWS account: add [awssm] with account = "..."`,
  readPin,
  parse,
  pinned: (reference, pin) => ({ ...reference, ...pin }),
  format,
  account,
  sameItem: (a, b) => a.region === b.region && a.name === b.name,
  sameField: (a, b) => a.field === b.field,
  stored: decode,
  newValueByHand: "Put a new value in the AWS secret",
  addRotatedDate: `Tag the AWS secret with ${ROTATED_TAG}<JSON key>, set to the day that key last changed as YYYY-MM-DD (${DOCS}).`,
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
    if (env[KEY_ID]) return [`keypin signs in to AWS with the credentials in ${KEY_ID}`];
    const profile = env[PROFILE]?.trim();
    return [`keypin signs in to AWS with the profile ${profile || "default"}`];
  },
  prerequisites({ failures }) {
    if (!failures.length) return [];
    const fix = failures.some((reason) => reason.kind === "wrong-account")
      ? `sign in to the AWS account keypin.toml pins under [awssm]`
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
