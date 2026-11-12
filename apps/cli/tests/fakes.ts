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
import type { Deps, FolderEntry, Launch, Lock } from "../src/deps";

export const SENTINEL = "sentinel-value-7f3a9c2e1d";

const HOME = "/home/me";
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
  items?: string[];
  ids?: Record<string, string>;
}

interface CreatedItem {
  ref: KeyRef;
  value: Secret;
  rotated: string | undefined;
}

export function fakeVault(options: FakeVaultOptions = {}) {
  const calls: string[] = [];
  const created: CreatedItem[] = [];
  const titles = () => [...(options.items ?? []), ...created.map((c) => c.ref.item)];
  const fail = (ref: KeyRef) => {
    if (options.failing?.includes(ref.item))
      throw new Error(`1Password: "${ref.item}" isn't readable`);
  };
  const stored = (ref: KeyRef) => {
    const made = created.find((c) => c.ref.item.toLowerCase() === ref.item.toLowerCase());
    if (made) return made.value;
    const found = options.values?.[ref.item];
    if (found === undefined) throw new Error(`no item "${ref.item}"`);
    return new Secret(found);
  };
  const value = (ref: KeyRef) => {
    calls.push(`read ${ref.item}`);
    fail(ref);
    return stored(ref);
  };
  const idsOf = (ref: KeyRef) => ({
    vault: `id-${ref.vault.toLowerCase()}`,
    item: options.ids?.[ref.item] ?? `id-${ref.item.toLowerCase()}`,
  });
  const vault: VaultBackend = {
    capabilities: { read: true, write: false, list: false, metadata: true },
    async read(ref) {
      return value(ref);
    },
    async readItem(ref) {
      return { secret: value(ref), ids: idsOf(ref) };
    },
    async itemIds(ref) {
      calls.push(`ids ${ref.item}`);
      fail(ref);
      stored(ref);
      return idsOf(ref);
    },
    async write(ref, secret, writeOptions = {}) {
      if (!options.items) throw new Error("the fake vault doesn't write");
      calls.push(`write ${ref.item}`);
      fail(ref);
      if (!writeOptions.newItem) throw new Error("the fake vault only creates items");
      if (titles().some((title) => title.toLowerCase() === ref.item.toLowerCase()))
        throw new Error(`"${ref.item}" already exists`);
      created.push({ ref, value: secret, rotated: writeOptions.rotated });
    },
    async list(scope) {
      if (!options.items) throw new Error("the fake vault doesn't list");
      calls.push(`list ${scope.account} ${scope.vault}`);
      return titles().map((title) => ({ id: title, title, tags: [], updatedAt: "" }));
    },
    async metadata(ref) {
      calls.push(`metadata ${ref.item}`);
      fail(ref);
      return options.metadata?.[ref.item] ?? { rotated: null };
    },
  };
  return { vault, calls, created };
}

function output() {
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
        : `github-actions:${target.repo}${target.environment === undefined ? "" : `/environments/${target.environment}`}`;
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
    self: {
      folder: "/work/billing",
      command: ["/opt/bun/bin/bun", "--no-env-file", "/home/me/keypin/apps/cli/src/main.ts"],
    },
    env: {},
    home: HOME,
    files: disk.files,
    isFolder: async (path) => disk.folders.has(path),
    listFolder: async (path) => listMemoryFolder(disk, path),
    git: async () => null,
    githubSecrets: async () => {
      throw new Error("this test reads no GitHub secrets");
    },
    workerSecrets: async () => {
      throw new Error("this test reads no Worker secrets");
    },
    createFile: async (path, text) => {
      if (disk.links.has(path)) return "link";
      if (disk.contents.has(path)) return "exists";
      disk.contents.set(path, text);
      return "created";
    },
    replaceFile: async (path, expected, text) => {
      if (disk.links.has(path)) return "link";
      if (disk.contents.get(path) !== expected) return "changed";
      disk.contents.set(path, text);
      return "replaced";
    },
    isLink: async (path) => disk.links.has(path),
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
    wranglerLoginFile: async () => null,
    lock: memoryLock(disk),
    isTerminal: false,
    ask: async () => {
      throw new Error("this test asks nothing");
    },
    ...setup.deps,
  };
  return { deps, disk, stdout, stderr };
}

function listMemoryFolder(disk: ReturnType<typeof memoryFiles>, path: string): FolderEntry[] {
  if (!disk.folders.has(path))
    throw Object.assign(new Error(`ENOENT: no folder ${path}`), { code: "ENOENT" });
  const prefix = path === "/" ? "/" : `${path}/`;
  const entries = new Map<string, FolderEntry["kind"]>();
  for (const [paths, kind] of [
    [[...disk.contents.keys()], "file"],
    [[...disk.folders], "folder"],
  ] as const) {
    for (const full of paths) {
      if (!full.startsWith(prefix) || full === path) continue;
      const [name, ...rest] = full.slice(prefix.length).split("/");
      if (!name) continue;
      entries.set(name, rest.length ? "folder" : disk.links.has(full) ? "other" : kind);
    }
  }
  return [...entries].map(([name, kind]) => ({ name, kind }));
}

export const BILLING_MAP = `
[1password]
account = "my.1password.com"

[keys.STRIPE_API_KEY]
rotate_every = "365d"
dev = "op://Private/billing stripe api key/password"
prod = { from = "op://Private/billing stripe api key/password", publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "billing-worker" },
  { to = "github-actions", repo = "acme/billing" },
] }
`;

export const WEB_MAP = `
[1password]
account = "my.1password.com"

[keys.SESSION_SECRET]
rotate_every = "180d"
dev = "op://Private/web dev session secret/password"
prod = { from = "op://Private/web prod session secret/password", publish = [
  { to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "web" },
] }
`;

export const registryWith = (...projects: string[]) =>
  JSON.stringify({ version: 1, projects, shared: [] });

export function leaks(...texts: string[]): boolean {
  return texts.some((t) => t.includes(SENTINEL));
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function memoryLock(disk: ReturnType<typeof memoryFiles>): Lock {
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
