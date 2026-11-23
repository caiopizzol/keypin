import type { IssuerRules, IssuerSpec, VaultRules } from "@keypin/core";
import { account, decode, format, parse, SCHEME, type SecretsManagerRef } from "./reference";
import { locate } from "./secretspec";

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

export const secretsManagerVaultRules: VaultRules<SecretsManagerRef, SecretsManagerRef> = {
  kind: "awssm",
  name: "AWS Secrets Manager",
  scheme: SCHEME,
  placeholder: "the secret's region and name",
  parse,
  pinned: (reference) => reference,
  format,
  account,
  sameItem: (a, b) => a.region === b.region && a.name === b.name,
  sameField: (a, b) => a.field === b.field,
  stored: decode,
  secretspec: { provider: "awssm", locate },
};
