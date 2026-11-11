import type { Files, KeyEntry, Receipt } from "../src/index";

export const MAP_FILE = "/work/web/keypin.toml";

export const VALID_MAP = `
[1password]
account = "my.1password.com"

[keys.SESSION_SECRET]
rotate_every = "180d"
dev  = "op://Private/web dev session secret/password"
prod = { from = "op://Private/web prod session secret/password", publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "web" },
  { to = "github-actions", repo = "acme/web" },
] }
`;

export const KEY: KeyEntry = {
  name: "STRIPE_API_KEY",
  rotateEvery: "365d",
  environments: {
    prod: {
      ref: {
        kind: "1password",
        account: "my.1password.com",
        vault: "Private",
        item: "billing stripe api key",
        section: null,
        field: "password",
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
};

export const KEY_MAP = "/work/billing/keypin.toml";

export const WORKER = "cloudflare-worker:billing-worker:STRIPE_API_KEY";
export const GITHUB = "github-actions:acme/billing:STRIPE_API_KEY";

export function receipt(
  destinationId: string,
  generation: string,
  overrides: Partial<Receipt> = {},
): Receipt {
  const destinationAccount = destinationId === GITHUB ? "acme" : "11111111111111111111111111111111";
  return {
    keyId: KEY.name,
    environment: "prod",
    mapFile: KEY_MAP,
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
