import type { IssuerKind } from "@keypin/core";
import { CloudflareIssuer } from "./issuer";
import { cloudflareIssuerRules, type CloudflareTokenSpec } from "./rules";

export const cloudflareIssuer: IssuerKind<CloudflareTokenSpec> = {
  ...cloudflareIssuerRules,
  adminExpiry: true,
  connect: ({ accountId }, admin, fetch) =>
    new CloudflareIssuer({
      admin: async () => admin,
      ...(accountId === undefined ? {} : { accountId }),
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
