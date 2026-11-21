import type { IssuerKind } from "@keypin/core";
import { XaiIssuer } from "./xai";
import { xaiIssuerRules, type XaiSpec } from "./rules";

export const xaiIssuer: IssuerKind<XaiSpec> = {
  ...xaiIssuerRules,
  connect: (_spec, admin, fetch) =>
    new XaiIssuer({
      admin: async () => admin,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
