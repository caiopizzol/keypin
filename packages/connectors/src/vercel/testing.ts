import { type Fetch, isRecord } from "@keypin/core";

export interface FakeVariable {
  id: string;
  key: string;
  type: string;
  target: string[];
  customEnvironmentIds: string[];
  gitBranch?: string;
}

export interface FakeVercel {
  username: string | null;
  teams: Record<string, { slug: string; projects: Record<string, string[]> }>;
  variables?: FakeVariable[];
  invalidToken?: boolean;
  failWrites?: boolean;
}

const PROJECT = /^\/(v9|v10)\/projects\/([^/]+)(\/env(?:\/([^/]+))?|\/custom-environments)?$/;

export function vercelFetch(fake: FakeVercel) {
  const values = new Map<string, string>();
  const effects: string[] = [];
  let made = 0;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const refuse = (status: number, code: string, message: string, extra: object = {}) =>
    reply(status, { error: { code, message, ...extra } });

  const fetch: Fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (fake.invalidToken)
      return refuse(403, "forbidden", "Not authorized", { invalidToken: true });
    if (pathname === "/v2/user")
      return fake.username === null
        ? refuse(403, "forbidden", "Not authorized")
        : reply(200, { user: { username: fake.username } });
    const [, , project = "", part = "", id] = PROJECT.exec(pathname) ?? [];
    const scope = searchParams.get("teamId") ?? searchParams.get("slug") ?? "";
    const team = Object.entries(fake.teams).find(
      ([teamId, t]) => teamId === scope || t.slug === scope,
    );
    const environments = team?.[1].projects[decodeURIComponent(project)];
    if (!team || !environments) return refuse(404, "not_found", "Project not found");
    const where = `${team[0]}/${decodeURIComponent(project)}`;
    const variables = (fake.variables ??= []);

    if (part === "") return reply(200, { id: `prj_${project}`, name: project, accountId: team[0] });
    if (part === "/custom-environments")
      return reply(200, {
        environments: environments.map((slug) => ({ id: `env_${slug}`, slug, type: "preview" })),
      });
    if (init.method === "GET") return reply(200, { envs: variables, pagination: { next: null } });

    const sent: unknown = JSON.parse(init.body ?? "{}");
    const body = isRecord(sent) ? sent : {};
    const value = typeof body.value === "string" ? body.value : "";
    if (fake.failWrites)
      return refuse(400, "bad_request", `could not store ${value} for ${String(body.key)}`);

    if (init.method === "PATCH" && id) {
      const found = variables.find((v) => v.id === decodeURIComponent(id));
      if (!found) return refuse(404, "not_found", "Environment variable not found");
      found.type = String(body.type);
      values.set(found.id, value);
      effects.push(`vercel update ${where} ${found.key}`);
      return reply(200, { ...found, value: "" });
    }
    if (init.method === "POST") {
      const key = String(body.key);
      const variable: FakeVariable = {
        id: `env-${++made}`,
        key,
        type: String(body.type),
        target: Array.isArray(body.target) ? body.target.map(String) : [],
        customEnvironmentIds: Array.isArray(body.customEnvironmentIds)
          ? body.customEnvironmentIds.map(String)
          : [],
      };
      variables.push(variable);
      values.set(variable.id, value);
      effects.push(`vercel create ${where} ${key}`);
      return reply(201, { created: { ...variable, value }, failed: [] });
    }
    return refuse(405, "method_not_allowed", "Method not allowed");
  };

  return {
    fetch,
    effects,
    variables: () => fake.variables ?? [],
    value: (key: string, environment: string) => {
      const found = (fake.variables ?? []).find(
        (v) =>
          v.key === key &&
          (v.target.includes(environment) || v.customEnvironmentIds.includes(`env_${environment}`)),
      );
      return found ? values.get(found.id) : undefined;
    },
  };
}
