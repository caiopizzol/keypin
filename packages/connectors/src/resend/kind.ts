import type { IssuerKind } from "@keypin/core";
import { ResendIssuer } from "./resend";
import { resendIssuerRules, type ResendSpec } from "./rules";

export const resendIssuer: IssuerKind<ResendSpec> = {
  ...resendIssuerRules,
  connect: ({ permission, domainId }, admin, fetch) =>
    new ResendIssuer({
      admin: async () => admin,
      permission,
      ...(domainId === undefined ? {} : { domainId }),
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
