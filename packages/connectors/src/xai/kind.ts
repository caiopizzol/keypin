import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { XaiIssuer } from "./xai";

export interface XaiSpec extends IssuerSpec {
  readonly kind: "xai";
}

export const xaiIssuer: IssuerKind<XaiSpec> = {
  kind: "xai",
  parse(read) {
    read.only([]);
    const admin = read.admin();
    if (!admin) return undefined;
    return { kind: "xai", admin };
  },
  connect: (_spec, admin, fetch) =>
    new XaiIssuer({
      admin: async () => admin,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
