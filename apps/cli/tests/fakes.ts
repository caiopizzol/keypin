import {
  type AccountCheck,
  type Destination,
  type Files,
  type KeyRef,
  type PublishTarget,
  Secret,
  type VaultBackend,
  type VaultMetadata,
} from "@keypin/core";
import type { Deps, Launch, Lock } from "../src/deps";

export const SENTINEL = "sentinel-value-7f3a9c2e1d";

export const HOME = "/home/me";
export const REGISTRY = "/home/me/.config/keypin/registry.json";
export const STATE = "/home/me/.local/state/keypin/state.json";

export function memoryFiles(initial: Record<string, string> = {}) {
  const contents = new Map(Object.entries(initial));
  const folders = new Set<string>([
    "/",
    "/work",
    "/work/billing",
    "/work/billing/src",
    "/work/web",
  ]);
  const files: Files = {
    async read(path) {
      return contents.get(path) ?? null;
    },
    async write(path, text) {
      contents.set(path, text);
    },
    async rename(from, to) {
      const text = contents.get(from);
      if (text === undefined) throw new Error(`no such file ${from}`);
      contents.set(to, text);
      contents.delete(from);
    },
  };
  const links = new Set<string>();
  return { files, contents, folders, links };
}

export interface FakeVaultOptions {
  values?: Record<string, string>;
  metadata?: Record<string, VaultMetadata>;
  failing?: string[];
}

export function fakeVault(options: FakeVaultOptions = {}) {
  const calls: string[] = [];
  const fail = (ref: KeyRef) => {
    if (options.failing?.includes(ref.item))
      throw new Error(`1Password: "${ref.item}" isn't readable`);
  };
  const vault: VaultBackend = {
    capabilities: { read: true, write: false, list: false, metadata: true },
    async read(ref) {
      calls.push(`read ${ref.item}`);
      fail(ref);
      const value = options.values?.[ref.item];
      if (value === undefined) throw new Error(`no item "${ref.item}"`);
      return new Secret(value);
    },
    async write(_ref: KeyRef, _secret: Secret) {
      throw new Error("the fake vault doesn't write");
    },
    async list() {
      throw new Error("the fake vault doesn't list");
    },
    async metadata(ref) {
      calls.push(`metadata ${ref.item}`);
      fail(ref);
      return options.metadata?.[ref.item] ?? { rotated: null, rotateEvery: null };
    },
  };
  return { vault, calls };
}

export function output() {
  let text = "";
  return {
    writer: { write: (chunk: string) => void (text += chunk) },
    get text() {
      return text;
    },
  };
}

export function fakeLauncher(code = 0) {
  const launches: { command: string[]; env: Record<string, string> }[] = [];
  const kills: string[] = [];
  let signalHandler: ((signal: NodeJS.Signals) => void) | undefined;
  const launch: Launch = (command, env) => {
    launches.push({ command, env });
    return {
      exited: Promise.resolve().then(() => {
        signalHandler?.("SIGINT");
        return code;
      }),
      kill: (signal) => void kills.push(signal),
    };
  };
  return {
    launch,
    onSignals: (handler: (signal: NodeJS.Signals) => void) => {
      signalHandler = handler;
      return () => void (signalHandler = undefined);
    },
    launches,
    kills,
    get listening() {
      return signalHandler !== undefined;
    },
  };
}

export interface FakeDestinationOptions {
  badAccount?: string[];
  failWrite?: string[];
}

export function fakeDestinations(options: FakeDestinationOptions = {}) {
  const log: string[] = [];
  const build = (target: PublishTarget): Destination => {
    const place =
      target.to === "cloudflare-worker"
        ? `cloudflare-worker:${target.worker}`
        : `github-actions:${target.repo}`;
    const owner = target.to === "cloudflare-worker" ? target.account : target.repo.split("/")[0];
    let checked = false;
    return {
      capabilities: { write: true, accountCheck: true, evidence: true },
      describe: () => place,
      async checkAccount(): Promise<AccountCheck> {
        log.push(`check ${place}`);
        const ok = !options.badAccount?.includes(place);
        checked = ok;
        return {
          publisher: target.to === "cloudflare-worker" ? "me@example.com" : target.account,
          destinationAccount: ok ? (owner ?? null) : null,
          expected: target.account,
          ok,
          ...(ok ? {} : { reason: `the login can't reach ${target.account}` }),
        };
      },
      async write(name, secret) {
        if (!checked) throw new Error("checkAccount hasn't passed");
        if (options.failWrite?.includes(place)) {
          log.push(`fail ${place}`);
          throw new Error(`HTTP 500 writing ${name}`);
        }
        log.push(`write ${place} ${name} (${secret.reveal().length} chars)`);
        return { destination: place, version: `v-${log.length}` };
      },
    };
  };
  return { build, log };
}

export interface FakeSetup {
  disk?: ReturnType<typeof memoryFiles>;
  backend?: VaultBackend;
  deps?: Partial<Deps>;
}

export function fakeDeps(setup: FakeSetup = {}) {
  const disk = setup.disk ?? memoryFiles();
  const stdout = output();
  const stderr = output();
  const backend = setup.backend ?? fakeVault().vault;
  const deps: Deps = {
    cwd: "/work/billing",
    self: ["/opt/bun/bin/bun", "/home/me/keypin/apps/cli/src/main.ts"],
    env: {},
    home: HOME,
    files: disk.files,
    isFolder: async (path) => disk.folders.has(path),
    createFile: async (path, text) => {
      if (disk.links.has(path)) return "link";
      if (disk.contents.has(path)) return "exists";
      disk.contents.set(path, text);
      return "created";
    },
    vault: () => backend,
    now: () => new Date(2026, 10, 9, 12, 0, 0),
    stdout: stdout.writer,
    stderr: stderr.writer,
    launch: () => {
      throw new Error("this test launches nothing");
    },
    onSignals: () => () => {},
    destination: () => {
      throw new Error("this test publishes nothing");
    },
    provider: () => {
      throw new Error("this test rotates nothing");
    },
    lock: memoryLock(disk),
    isTerminal: false,
    ask: async () => {
      throw new Error("this test asks nothing");
    },
    ...setup.deps,
  };
  return { deps, disk, stdout, stderr };
}

export const BILLING_MAP = `
[vaults.personal]
kind = "1password"
account = "my.1password.com"
vault = "Private"

[keys.billing-stripe]
env = "STRIPE_API_KEY"
owner = "billing"
dev = { vault = "personal", item = "billing stripe api key" }
prod = { vault = "personal", item = "billing stripe api key", publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "billing-worker" },
  { to = "github-actions", repo = "acme/billing" },
] }
`;

export const WEB_MAP = `
[vaults.personal]
kind = "1password"
account = "my.1password.com"
vault = "Private"

[keys.web-session]
env = "SESSION_SECRET"
owner = "web"
dev = { vault = "personal", item = "web dev session secret" }
prod = { vault = "personal", item = "web prod session secret", publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "web" },
] }
consumers = [{ name = "support-bot", kind = "manual" }]
`;

export const registryWith = (...projects: string[]) =>
  JSON.stringify({ version: 1, projects, shared: [] });

export function leaks(...texts: string[]): boolean {
  return texts.some((t) => t.includes(SENTINEL));
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function memoryLock(disk: ReturnType<typeof memoryFiles>): Lock {
  return async (path) => {
    const text = disk.contents.get(path);
    if (text !== undefined) {
      const pid = text.match(/^(\d+)\n$/)?.[1];
      return {
        held: false,
        holder: { pid: pid === undefined ? null : Number(pid), running: true },
      };
    }
    disk.contents.set(path, `${process.pid}\n`);
    const release = async () => {
      disk.contents.delete(path);
    };
    return { held: true, lock: { release } };
  };
}
