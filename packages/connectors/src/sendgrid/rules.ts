import type { IssuerRules, IssuerSpec } from "@keypin/core";

export interface SendGridSpec extends IssuerSpec {
  readonly kind: "sendgrid";
  readonly subuser?: string;
  readonly region?: "eu";
}

export const sendgridIssuerRules = {
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
} satisfies IssuerRules<SendGridSpec>;
