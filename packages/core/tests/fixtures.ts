import type { Files, KeyEntry, Receipt } from "../src/index";

export const MAP_FILE = "/work/web/keypin.toml";

export const VALID_MAP = `
[vaults."1password"]       # quoted: Bun 1.3 can't parse a bare key starting with a digit
kind = "1password"
account = "my.1password.com"
vault = "Private"

[keys.web-session]          # stable key ID, independent of vault item names
env = "SESSION_SECRET"
owner = "web"
rotate_every = "180d"
dev  = { vault = "1password", item = "web dev session secret" }
prod = { vault = "1password", item = "web prod session secret", publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "web" },
  { to = "github-actions", repo = "acme/web" },
] }
consumers = [{ name = "support-bot", kind = "manual" }]
`;

export const KEY: KeyEntry = {
  id: "billing-stripe",
  env: "STRIPE_API_KEY",
  owner: "billing",
  rotateEvery: "365d",
  environments: {
    prod: {
      ref: {
        kind: "1password",
        account: "my.1password.com",
        vault: "Private",
        item: "billing stripe api key",
      },
      publish: [
        {
          to: "cloudflare-worker",
          account: "11111111111111111111111111111111",
          worker: "billing-worker",
        },
        { to: "github-actions", repo: "acme/billing", account: "acme" },
      ],
    },
  },
  consumers: [],
};

export const WORKER = "cloudflare-worker:billing-worker:STRIPE_API_KEY";
export const GITHUB = "github-actions:acme/billing:STRIPE_API_KEY";

export function receipt(
  destinationId: string,
  generation: string,
  overrides: Partial<Receipt> = {},
): Receipt {
  const destinationAccount = destinationId === GITHUB ? "acme" : "11111111111111111111111111111111";
  return {
    keyId: KEY.id,
    environment: "prod",
    source: KEY.environments.prod?.ref ?? null,
    destinationId,
    generation,
    account: { pinned: destinationAccount, publisher: "acme", destinationAccount },
    at: "2026-11-09T15:30:35Z",
    evidence: { version: "a1b2c3d4" },
    ...overrides,
  };
}

export function fakeFiles(initial: Record<string, string> = {}) {
  const contents = new Map(Object.entries(initial));
  const log: string[] = [];
  let failOn: "write" | "rename" | null = null;
  const files: Files = {
    async read(path) {
      log.push(`read ${path}`);
      return contents.get(path) ?? null;
    },
    async write(path, text) {
      log.push(`write ${path}`);
      if (failOn === "write") throw new Error("disk full");
      contents.set(path, text);
    },
    async rename(from, to) {
      log.push(`rename ${from} -> ${to}`);
      if (failOn === "rename") throw new Error("crashed before rename");
      const text = contents.get(from);
      if (text === undefined) throw new Error(`no such file ${from}`);
      contents.set(to, text);
      contents.delete(from);
    },
  };
  return {
    files,
    contents,
    log,
    fail(on: "write" | "rename" | null) {
      failOn = on;
    },
  };
}
