import { isRecord } from "@keypin/core";
import type { Fetch } from "@keypin/vault-infisical";

export const INFISICAL_TOKEN = "infisical-access-token-5d8e";

export interface FakeSecret {
  value: string;
  rotated?: string;
}

export interface FakeInfisical {
  organization: string;
  projects: Record<string, Record<string, Record<string, FakeSecret>>>;
}

export interface Stored {
  project: string;
  environment: string;
  name: string;
  secret: FakeSecret;
}

export function infisicalFetch(
  fake: FakeInfisical,
  store: { load(): Stored[]; save(entry: Stored): void; effect(line: string): void },
): Fetch {
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const secretsOf = (project: string, environment: string) => {
    const base = fake.projects[project]?.[environment] ?? {};
    const added = store
      .load()
      .filter((s) => s.project === project && s.environment === environment);
    return { ...base, ...Object.fromEntries(added.map((s) => [s.name, s.secret])) };
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
    const secrets = secretsOf(project, environment);
    const found = secrets[name];
    const shape = (key: string, secret: FakeSecret, value: boolean) => ({
      id: `${project}/${environment}/${key}`,
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
    if (init.method === "GET")
      return found
        ? reply(200, { secret: shape(name, found, query.viewSecretValue === "true") })
        : reply(404, { message: `Secret with name '${name}' not found` });
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
    store.save({ project, environment, name, secret });
    store.effect(
      `infisical ${init.method === "POST" ? "create" : "update"} ${project}/${environment}/${name}`,
    );
    return reply(200, { secret: shape(name, secret, false) });
  };
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
          s.name === entry.name,
      );
      if (at === -1) saved.push(entry);
      else saved[at] = entry;
    },
    effect: (line: string) => void effects.push(line),
    effects,
  };
}
