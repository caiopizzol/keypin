import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { CloudflareIssuer } from "./issuer";

export interface CloudflareTokenSpec extends IssuerSpec {
  readonly kind: "cloudflare";
  readonly accountId?: string;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

export const cloudflareIssuer: IssuerKind<CloudflareTokenSpec> = {
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
  connect: ({ accountId }, admin, fetch) =>
    new CloudflareIssuer({
      admin: async () => admin,
      ...(accountId === undefined ? {} : { accountId }),
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
