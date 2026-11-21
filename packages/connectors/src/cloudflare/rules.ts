import type { DestinationRules, IssuerRules, IssuerSpec } from "@keypin/core";

export interface CloudflareTokenSpec extends IssuerSpec {
  readonly kind: "cloudflare";
  readonly accountId?: string;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

export type WorkerTarget = { to: "cloudflare-worker"; account: string; worker: string };

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

export const cloudflareWorkerRules: DestinationRules<WorkerTarget> = {
  kind: "cloudflare-worker",
  label: "Cloudflare",
  parse(read) {
    read.only(["account", "worker"]);
    const account = read.filledIn(
      read.required("account"),
      "account",
      "the Cloudflare account ID the Worker belongs to (32 hex characters; wrangler whoami lists it)",
    );
    const worker = read.filledIn(
      read.required("worker"),
      "worker",
      `the Worker's name, the "name" in its wrangler config`,
    );
    if (account !== undefined && !ACCOUNT_ID.test(account))
      read.fail(`field "account" must be a Cloudflare account ID (32 hex characters)`);
    return account === undefined || worker === undefined
      ? undefined
      : { to: "cloudflare-worker", account, worker };
  },
  id: ({ worker }) => worker,
  secretId: ({ account, worker }, secretName) => `${account}:${worker}:${secretName}`,
  checkId: ({ account, worker }) => `${account}/${worker}`,
  fromId: (id, pinned) =>
    id && !id.includes(":") ? { to: "cloudflare-worker", account: pinned, worker: id } : undefined,
  describe: ({ worker }) => worker,
  named: ({ worker }) => `the Worker ${worker}`,
};
