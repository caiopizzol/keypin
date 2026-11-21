import type { IssuerRules, IssuerSpec } from "@keypin/core";

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
