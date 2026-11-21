import type { IssuerKind } from "@keypin/core";
import { SendGridIssuer } from "./sendgrid";
import { sendgridIssuerRules, type SendGridSpec } from "./rules";

export const sendgridIssuer: IssuerKind<SendGridSpec> = {
  ...sendgridIssuerRules,
  connect: ({ subuser, region }, admin, fetch) =>
    new SendGridIssuer({
      admin: async () => admin,
      ...(subuser === undefined ? {} : { subuser }),
      ...(region === undefined ? {} : { region }),
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
