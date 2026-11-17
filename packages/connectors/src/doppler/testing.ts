import { type Fetch, isRecord } from "@keypin/core";

export interface FakeSecret {
  value: string;
  restricted?: boolean;
}

export type FakeToken =
  | { type: "service_token"; project: string; config: string; access: "read" | "read/write" }
  | { type: "service_account"; write?: boolean }
  | { type: "personal" };

type Projects = Record<string, Record<string, Record<string, FakeSecret>>>;

export interface FakeDoppler {
  workplace: string;
  projects: Projects;
  tokens: Record<string, FakeToken>;
  failWrites?: boolean;
}

export interface Stored {
  project: string;
  config: string;
  name: string;
  secret: FakeSecret;
}

export interface Store {
  load(): Stored[];
  save(entry: Stored): void;
  effect(line: string): void;
}

const REFERENCE = /\$\{([^}]+)\}/g;
const same = (a: Stored, b: Stored) =>
  a.project === b.project && a.config === b.config && a.name === b.name;

export function dopplerFetch(fake: FakeDoppler, store: Store): Fetch {
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const fail = (status: number, message: string) =>
    reply(status, { messages: [message], success: false });
  const secretsOf = (project: string, config: string): Record<string, FakeSecret> => ({
    ...fake.projects[project]?.[config],
    ...Object.fromEntries(
      store
        .load()
        .filter((s) => s.project === project && s.config === config)
        .map((s) => [s.name, s.secret]),
    ),
  });
  const computed = (project: string, config: string, raw: string): string =>
    raw.replace(REFERENCE, (whole, inner: string) => {
      const parts = inner.split(".");
      const name = parts.pop() ?? "";
      const at = { config: parts.pop() ?? config, project: parts.pop() ?? project };
      return secretsOf(at.project, at.config)[name]?.value ?? whole;
    });
  return async (url, init) => {
    const parsed = new URL(url);
    const bearer = init.headers.Authorization?.replace(/^Bearer /, "") ?? "";
    const token = fake.tokens[bearer];
    if (!token) return fail(401, "Invalid Auth token");
    if (parsed.pathname === "/v3/me")
      return reply(200, {
        workplace: { slug: fake.workplace, name: `${fake.workplace} Inc` },
        type: token.type,
      });
    const sent: unknown = init.body ? JSON.parse(init.body) : null;
    const body = isRecord(sent) ? sent : {};
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const project = parsed.searchParams.get("project") ?? text(body.project);
    const config = parsed.searchParams.get("config") ?? text(body.config);
    if (token.type === "service_token" && (token.project !== project || token.config !== config))
      return fail(403, "This token does not have access to requested config");
    if (!fake.projects[project]?.[config]) return fail(404, "Could not find requested config");
    const secrets = secretsOf(project, config);
    const user = token.type === "personal";
    if (init.method === "GET" && parsed.pathname === "/v3/configs/config/secrets/names")
      return reply(200, { names: Object.keys(secrets) });
    if (init.method === "GET" && parsed.pathname === "/v3/configs/config/secret") {
      const name = parsed.searchParams.get("name") ?? "";
      const found = secrets[name];
      if (!found) return fail(404, "Could not find requested secret");
      const hidden = found.restricted && user;
      return reply(200, {
        name,
        value: {
          raw: hidden ? null : found.value,
          computed: hidden ? null : computed(project, config, found.value),
          note: "",
          rawVisibility: found.restricted ? "restricted" : "masked",
        },
      });
    }
    if (init.method === "POST" && parsed.pathname === "/v3/configs/config/secrets") {
      const writes =
        token.type === "service_token"
          ? token.access === "read/write"
          : token.type === "personal" || token.write === true;
      if (!writes) return fail(403, "You do not have permission to perform this action");
      if (fake.failWrites) return fail(500, "internal error");
      const changed = isRecord(body.secrets) ? body.secrets : {};
      for (const [name, value] of Object.entries(changed)) {
        const before = secrets[name];
        store.save({
          project,
          config,
          name,
          secret: { value: text(value), ...(before?.restricted ? { restricted: true } : {}) },
        });
        store.effect(`doppler ${before ? "update" : "create"} ${project}/${config}/${name}`);
      }
      return reply(200, {
        success: true,
        secrets: Object.fromEntries(
          Object.keys(changed).map((name) => [name, { raw: null, computed: null, note: "" }]),
        ),
      });
    }
    return fail(404, `no ${init.method} ${parsed.pathname}`);
  };
}

export function memoryStore() {
  const saved: Stored[] = [];
  const effects: string[] = [];
  return {
    load: () => saved,
    save: (entry: Stored) => {
      const at = saved.findIndex((s) => same(s, entry));
      if (at === -1) saved.push(entry);
      else saved[at] = entry;
    },
    effect: (line: string) => void effects.push(line),
    effects,
  };
}

export function fileStore(
  read: () => string | null,
  write: (text: string) => void,
  effect: (line: string) => void,
): Store {
  const load = (): Stored[] => {
    try {
      const parsed: unknown = JSON.parse(read() ?? "[]");
      return Array.isArray(parsed) ? parsed.filter(isStored) : [];
    } catch {
      return [];
    }
  };
  return {
    load,
    save: (entry) => write(JSON.stringify([...load().filter((s) => !same(s, entry)), entry])),
    effect,
  };
}

function isStored(entry: unknown): entry is Stored {
  return (
    isRecord(entry) &&
    typeof entry.project === "string" &&
    typeof entry.config === "string" &&
    typeof entry.name === "string" &&
    isRecord(entry.secret) &&
    typeof entry.secret.value === "string"
  );
}
