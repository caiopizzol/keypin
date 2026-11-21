import type { DestinationRules } from "@keypin/core";

const URL_PATTERN = /^https:\/\/([a-z0-9-]+)(\.[a-z0-9-]+)?\.convex\.cloud\/?$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const NAME_LIMIT = 256;
const SYSTEM = new Set(["CONVEX_CLOUD_URL", "CONVEX_SITE_URL"]);

export function refusedName(name: string): string | undefined {
  if (SYSTEM.has(name)) return `Convex sets ${name} itself`;
  if (!NAME.test(name))
    return "Convex names must start with a letter and use only letters, digits and _";
  if (name.length > NAME_LIMIT) return `Convex takes names of up to ${NAME_LIMIT} characters`;
  return undefined;
}

export function deploymentOf(url: string): string | undefined {
  return URL_PATTERN.exec(url)?.[1];
}

export type ConvexTarget = {
  to: "convex-deployment";
  account: string;
  url: string;
};

const host = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");

export const convexDeploymentRules: DestinationRules<ConvexTarget> = {
  kind: "convex-deployment",
  label: "Convex",
  parse(read) {
    read.only(["url"]);
    const url = read.filledIn(
      read.required("url"),
      "url",
      "the Convex deployment's URL, such as https://happy-animal-123.convex.cloud, from its settings",
    );
    if (url === undefined) return undefined;
    const account = deploymentOf(url);
    if (!account) {
      read.fail(
        `field "url" must be the deployment's convex.cloud URL, such as https://happy-animal-123.convex.cloud`,
      );
      return undefined;
    }
    return { to: "convex-deployment", account, url: `https://${host(url)}` };
  },
  id: ({ url }) => host(url),
  secretId: ({ url }, secretName) => `${host(url)}:${secretName}`,
  checkId: ({ url }) => host(url),
  fromId(id) {
    const url = `https://${id}`;
    const account = deploymentOf(url);
    return account ? { to: "convex-deployment", account, url } : undefined;
  },
  describe: ({ account }) => account,
  named: ({ account }) => `the environment variables of Convex deployment ${account}`,
  refuses: refusedName,
};
