import { type Fetch, isRecord } from "@keypin/core";

export const INFISICAL_TOKEN = "infisical-access-token-5d8e";

export interface FakeSecret {
  value: string;
  rotated?: string;
}

type Projects = Record<string, Record<string, Record<string, FakeSecret>>>;

export interface FakeInfisical {
  organization: string;
  projects: Projects;
  importedForReads?: Projects;
  heldByPolicy?: Stored[];
  failWrites?: boolean;
}

export interface Stored {
  project: string;
  environment: string;
  path?: string;
  name: string;
  secret: FakeSecret;
}

const ROOT = "/";
const pathOf = (key: string) => {
  const slash = key.lastIndexOf("/");
  return slash <= 0 ? ROOT : key.slice(0, slash);
};
const nameOf = (key: string) => key.slice(key.lastIndexOf("/") + 1);

export function infisicalFetch(
  fake: FakeInfisical,
  store: { load(): Stored[]; save(entry: Stored): void; effect(line: string): void },
): Fetch {
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const secretsOf = (
    project: string,
    environment: string,
    path: string,
    projects = fake.projects,
  ) => {
    const base = Object.entries(projects[project]?.[environment] ?? {})
      .filter(([key]) => pathOf(key) === path)
      .map(([key, secret]): [string, FakeSecret] => [nameOf(key), secret]);
    const added = (projects === fake.projects ? store.load() : []).filter(
      (s) => s.project === project && s.environment === environment && (s.path ?? ROOT) === path,
    );
    return {
      ...Object.fromEntries(base),
      ...Object.fromEntries(added.map((s) => [s.name, s.secret])),
    };
  };
  return async (url, init) => {
    const parsed = new URL(url);
    const sent: unknown = init.body ? JSON.parse(init.body) : null;
    const body = isRecord(sent) ? sent : {};
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const query = Object.fromEntries(parsed.searchParams);
    if (parsed.pathname === "/api/v1/auth/universal-auth/login")
      return reply(200, { accessToken: INFISICAL_TOKEN, expiresIn: 7200, tokenType: "Bearer" });
    if (init.headers.Authorization !== `Bearer ${INFISICAL_TOKEN}`)
      return reply(401, { message: "Unauthorized" });
    if (parsed.pathname === "/api/v1/identities/details")
      return reply(200, {
        identityDetails: {
          organization: { id: "org", name: fake.organization, slug: fake.organization },
        },
      });
    const slug = /^\/api\/v1\/projects\/slug\/(.+)$/.exec(parsed.pathname)?.[1];
    if (slug !== undefined)
      return fake.projects[slug]
        ? reply(200, { id: slug, slug })
        : reply(404, { message: "Project not found" });
    const name = decodeURIComponent(parsed.pathname.replace(/^\/api\/v4\/secrets\/?/, ""));
    const project = query.projectId ?? text(body.projectId);
    const environment = query.environment ?? text(body.environment);
    const path = query.secretPath ?? (text(body.secretPath) || ROOT);
    const secrets = secretsOf(project, environment, path);
    const imported =
      query.includeImports === "true" && !secrets[name]
        ? secretsOf(project, environment, path, fake.importedForReads)[name]
        : undefined;
    const found = secrets[name];
    const shape = (key: string, secret: FakeSecret, value: boolean, from = "") => ({
      id: `${from}${project}/${environment}/${key}`,
      secretKey: key,
      secretValue: value ? secret.value : "",
      secretValueHidden: !value,
      secretMetadata: secret.rotated ? [{ key: "rotated", value: secret.rotated }] : [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    if (init.method === "GET" && name === "")
      return reply(200, {
        secrets: Object.entries(secrets).map(([key, secret]) => shape(key, secret, false)),
      });
    if (init.method === "GET") {
      const view = query.viewSecretValue === "true";
      if (found) return reply(200, { secret: shape(name, found, view) });
      if (imported) return reply(200, { secret: shape(name, imported, view, "imported:") });
      return reply(404, { message: `Secret with name '${name}' not found` });
    }
    if (fake.failWrites) return reply(500, { message: "internal error" });
    const metadata = Array.isArray(body.secretMetadata) ? body.secretMetadata : null;
    const rotated = metadata?.filter(isRecord).find((entry) => entry.key === "rotated")?.value;
    const secret: FakeSecret = {
      value: text(body.secretValue),
      ...(typeof rotated === "string"
        ? { rotated }
        : found?.rotated
          ? { rotated: found.rotated }
          : {}),
    };
    const change = `${init.method === "POST" ? "create" : "update"} ${project}/${environment}/${name}`;
    if (fake.heldByPolicy) {
      fake.heldByPolicy.push({ project, environment, path, name, secret });
      store.effect(`infisical hold ${change}`);
      return reply(200, {
        approval: { id: `approval-${fake.heldByPolicy.length}`, status: "open" },
      });
    }
    store.save({ project, environment, path, name, secret });
    store.effect(`infisical ${change}`);
    return reply(200, { secret: shape(name, secret, false) });
  };
}

export function mergeHeld(fake: FakeInfisical, store: { save(entry: Stored): void }): void {
  for (const entry of fake.heldByPolicy?.splice(0) ?? []) store.save(entry);
}

export function memoryStore() {
  const saved: Stored[] = [];
  const effects: string[] = [];
  return {
    load: () => saved,
    save: (entry: Stored) => {
      const at = saved.findIndex(
        (s) =>
          s.project === entry.project &&
          s.environment === entry.environment &&
          (s.path ?? ROOT) === (entry.path ?? ROOT) &&
          s.name === entry.name,
      );
      if (at === -1) saved.push(entry);
      else saved[at] = entry;
    },
    effect: (line: string) => void effects.push(line),
    effects,
  };
}
