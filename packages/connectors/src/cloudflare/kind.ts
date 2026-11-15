import type { DestinationKind } from "@keypin/core";
import { WorkerSecretDestination } from "./cloudflare";
import { wranglerDiscovery, type WranglerHost } from "./discovery";
import { currentWranglerToken } from "./token";

export type WorkerTarget = { to: "cloudflare-worker"; account: string; worker: string };

export interface WorkerPublisher {
  refreshLogins: boolean;
  wranglerFile?: string | null;
}

export interface WorkerHost extends WranglerHost {
  wranglerLoginFile(): Promise<string | null>;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

export const cloudflareWorker: DestinationKind<WorkerTarget, WorkerPublisher, WorkerHost> = {
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
  where: ({ worker }) => `the Worker ${worker}`,
  login: (_target, { wranglerFile }) =>
    `the wrangler login${wranglerFile ? ` in ${wranglerFile}` : ""}`,
  async publisher(host) {
    const file = await host.wranglerLoginFile();
    return {
      fields: { wranglerFile: file },
      notes:
        file === null
          ? []
          : [
              `the wrangler login is an OAuth token stored in plain text in ${file}; wrangler logout removes it`,
            ],
    };
  },
  discovery: wranglerDiscovery,
  prerequisites: async ({ targets, used }, host) =>
    (used || targets.length) && !(await host.wranglerLoginFile())
      ? [
          {
            name: "Cloudflare",
            status: "not logged in",
            fix: "run wrangler login",
            title: "Sign in to Cloudflare",
            body: ["  wrangler login"],
            coversFailures: false,
          },
        ]
      : [],
  connect: ({ account, worker }, publisher) =>
    new WorkerSecretDestination({
      account,
      worker,
      ...(publisher.refreshLogins ? {} : { token: () => currentWranglerToken() }),
    }),
};
