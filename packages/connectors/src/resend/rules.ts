import type { IssuerRules, IssuerSpec } from "@keypin/core";

const PERMISSIONS = ["full_access", "sending_access"] as const;

export interface ResendSpec extends IssuerSpec {
  readonly kind: "resend";
  readonly permission: (typeof PERMISSIONS)[number];
  readonly domainId?: string;
}

export const resendIssuerRules = {
  kind: "resend",
  parse(read) {
    read.only(["permission", "domain_id"]);
    const admin = read.admin();
    const given = read.required("permission");
    const permission = PERMISSIONS.find((known) => known === given);
    if (given !== undefined && !permission)
      read.fail(
        `field "permission" must be one of: ${PERMISSIONS.join(", ")}, as the key has at Resend`,
      );
    const domainId = read.filledIn(read.optional("domain_id"), "domain_id", "the Resend domain ID");
    if (domainId !== undefined && permission === "full_access")
      read.fail(`field "domain_id" works only with permission = "sending_access"`);
    if (!admin || !permission) return undefined;
    const spec: ResendSpec = { kind: "resend", admin, permission };
    return domainId === undefined ? spec : { ...spec, domainId };
  },
} satisfies IssuerRules<ResendSpec>;
