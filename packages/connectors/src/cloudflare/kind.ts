import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { WorkerSecretDestination } from "./cloudflare";
import { wranglerDiscovery, type WranglerHost } from "./discovery";
import { cloudflareWorkerRules, type WorkerTarget } from "./rules";
import { API_TOKEN_VARIABLE, type CloudflareSignIn, CloudflareSignInFailed } from "./token";

export interface WorkerPublisher {
  workerSignIn: CloudflareSignIn | null;
}

export interface WorkerHost extends WranglerHost {
  workerSignIn(folder: string): CloudflareSignIn;
}

const SIGNED_IN_AS: Record<CloudflareSignIn["via"], string> = {
  oauth: "the wrangler login (OAuth)",
  "api-token": `the API token in ${API_TOKEN_VARIABLE}`,
};

async function signInPrerequisites(signIn: CloudflareSignIn): Promise<Prerequisite[]> {
  try {
    await signIn.token();
    return [];
  } catch (error) {
    const kind = error instanceof CloudflareSignInFailed ? error.kind : "failed";
    const message = error instanceof Error ? error.message : String(error);
    const step = { name: "Cloudflare", coversFailures: true };
    const or = `Or set ${API_TOKEN_VARIABLE} to a Cloudflare API token.`;
    if (kind === "no-wrangler")
      return [
        {
          ...step,
          status: "not installed",
          fix: `install wrangler in the project, then run wrangler login, or set ${API_TOKEN_VARIABLE}`,
          title: "Install wrangler and sign in to Cloudflare",
          body: [
            "Install wrangler in the project (npm i -D wrangler), then run:",
            "  wrangler login",
            or,
          ],
        },
      ];
    if (kind === "not-logged-in")
      return [
        {
          ...step,
          status: "not logged in",
          fix: `run wrangler login, or set ${API_TOKEN_VARIABLE}`,
          title: "Sign in to Cloudflare",
          body: ["  wrangler login", or],
        },
      ];
    return [
      {
        ...step,
        status: "sign-in failed",
        fix: message,
        title: "Sign in to Cloudflare",
        body: [sentence(message)],
      },
    ];
  }
}

export const cloudflareWorker: DestinationKind<WorkerTarget, WorkerPublisher, WorkerHost> = {
  ...cloudflareWorkerRules,
  where: ({ worker }) => `the Worker ${worker}`,
  login: (_target, { workerSignIn }) => SIGNED_IN_AS[workerSignIn?.via ?? "oauth"],
  signInVariables: [API_TOKEN_VARIABLE],
  writeNote: "writing a Worker secret deploys a new version of the Worker",
  publisher: async (host, folder) => ({ fields: { workerSignIn: host.workerSignIn(folder) } }),
  discovery: wranglerDiscovery,
  prerequisites: async ({ folder, targets, used }, host) =>
    used || targets.length ? signInPrerequisites(host.workerSignIn(folder)) : [],
  connect: ({ account, worker }, { workerSignIn }) => {
    if (!workerSignIn) throw new Error("keypin has no Cloudflare sign-in for this publish");
    return new WorkerSecretDestination({ account, worker, token: () => workerSignIn.token() });
  },
};
