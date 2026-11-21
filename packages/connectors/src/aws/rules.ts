import type { IssuerRules, IssuerSpec, VaultRules } from "@keypin/core";
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

export interface AwsSpec extends IssuerSpec {
  readonly kind: "aws";
  readonly keyId: string;
}

export const awsIssuerRules = {
  kind: "aws",
  parse(read) {
    read.only(["key_id"]);
    const admin = read.admin();
    const keyId = read.idKey();
    return admin && keyId ? { kind: "aws", admin, keyId } : undefined;
  },
  idKey: (spec) => spec.keyId,
} satisfies IssuerRules<AwsSpec>;

export const secretsManagerVaultRules: VaultRules<
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
};
