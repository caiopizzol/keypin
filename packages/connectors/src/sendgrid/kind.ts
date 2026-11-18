import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { SendGridIssuer } from "./sendgrid";

export interface SendGridSpec extends IssuerSpec {
  readonly kind: "sendgrid";
  readonly subuser?: string;
  readonly region?: "eu";
}

export const sendgridIssuer: IssuerKind<SendGridSpec> = {
  kind: "sendgrid",
  parse(read) {
    read.only(["subuser", "region"]);
    const admin = read.admin();
    const subuser = read.filledIn(read.optional("subuser"), "subuser", "the subuser's username");
    const region = read.optional("region");
    if (region !== undefined && region !== "eu")
      read.fail(`field "region" must be "eu" for an EU regional subuser, or left out`);
    if (!admin) return undefined;
    return {
      kind: "sendgrid",
      admin,
      ...(subuser === undefined ? {} : { subuser }),
      ...(region === "eu" ? { region } : {}),
    };
  },
  connect: ({ subuser, region }, admin, fetch) =>
    new SendGridIssuer({
      admin: async () => admin,
      ...(subuser === undefined ? {} : { subuser }),
      ...(region === undefined ? {} : { region }),
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
