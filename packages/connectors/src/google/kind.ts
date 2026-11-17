import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { GoogleIssuer } from "./google";

export interface GoogleSpec extends IssuerSpec {
  readonly kind: "google";
}

export const googleIssuer: IssuerKind<GoogleSpec> = {
  kind: "google",
  parse(read) {
    read.only([]);
    const admin = read.admin();
    if (!admin) return undefined;
    return { kind: "google", admin };
  },
  connect: (_spec, admin, fetch) =>
    new GoogleIssuer({
      admin: async () => admin,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
