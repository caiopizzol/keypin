import type { IssuerRules, IssuerSpec } from "@keypin/core";

export interface XaiSpec extends IssuerSpec {
  readonly kind: "xai";
}

export const xaiIssuerRules = {
  kind: "xai",
  parse(read) {
    read.only([]);
    const admin = read.admin();
    if (!admin) return undefined;
    return { kind: "xai", admin };
  },
} satisfies IssuerRules<XaiSpec>;
