import type { IssuerKind, IssuerSpec } from "@keypin/core";

interface PairedSpec extends IssuerSpec {
  readonly kind: "paired";
  readonly keyId: string;
}

export const pairedKind: IssuerKind<PairedSpec> = {
  kind: "paired",
  parse(read) {
    read.only(["key_id"]);
    const admin = read.admin();
    const keyId = read.idKey();
    return admin && keyId ? { kind: "paired", admin, keyId } : undefined;
  },
  connect: () => {
    throw new Error("tests build the paired issuer themselves");
  },
  idKey: (spec) => spec.keyId,
};
