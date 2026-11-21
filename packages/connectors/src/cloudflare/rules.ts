import type { IssuerRules, IssuerSpec } from "@keypin/core";

export interface CloudflareTokenSpec extends IssuerSpec {
  readonly kind: "cloudflare";
  readonly accountId?: string;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

export const cloudflareIssuerRules = {
  kind: "cloudflare",
  parse(read) {
    read.only(["account_id"]);
    const admin = read.admin();
    const accountId = read.optional("account_id");
    if (accountId !== undefined && !ACCOUNT_ID.test(accountId)) {
      read.fail(`field "account_id" must be a Cloudflare account ID (32 hex characters)`);
      return undefined;
    }
    if (!admin) return undefined;
    return { kind: "cloudflare", admin, ...(accountId === undefined ? {} : { accountId }) };
  },
} satisfies IssuerRules<CloudflareTokenSpec>;
