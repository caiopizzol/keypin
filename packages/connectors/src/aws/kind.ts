import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { AwsIssuer } from "./aws";

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
