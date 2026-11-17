import { type Fetch, isRecord, objectField } from "@keypin/core";

export interface FakeNode {
  id: string;
  name: string;
  canAccess?: boolean;
}

export interface FakeProject {
  environments: FakeNode[];
  services: FakeNode[];
}

export interface FakeRailway {
  email: string | null;
  projects: Record<string, FakeProject>;
  projectToken?: { projectId: string; environmentId: string };
  invalidToken?: boolean;
  failWrites?: boolean;
}

export function railwayFetch(fake: FakeRailway) {
  const values = new Map<string, string>();
  const effects: string[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const refuse = (message = "Not Authorized") =>
    reply({ errors: [{ message, extensions: { code: "INTERNAL_SERVER_ERROR" } }], data: null });
  const edges = (list: FakeNode[]) => ({ edges: list.map((node) => ({ node })) });

  const fetch: Fetch = async (_url, init) => {
    const sent: unknown = JSON.parse(init.body ?? "{}");
    const query = isRecord(sent) && typeof sent.query === "string" ? sent.query : "";
    const variables = isRecord(sent) ? objectField(sent, "variables") : {};
    const scoped = init.headers["Project-Access-Token"] !== undefined;
    const token = fake.projectToken;
    if (fake.invalidToken || scoped !== Boolean(token))
      return refuse(query.includes("projectToken") ? "Project Token not found" : undefined);

    if (query.includes("projectToken")) return reply({ data: { projectToken: token } });
    if (query.includes("me {"))
      return fake.email === null ? refuse() : reply({ data: { me: { email: fake.email } } });

    if (query.includes("project(")) {
      const id = String(variables.id);
      const project = fake.projects[id];
      if (!project || (token && token.projectId !== id)) return refuse("Project not found");
      return reply({
        data: {
          project: { environments: edges(project.environments), services: edges(project.services) },
        },
      });
    }

    if (query.includes("variableUpsert")) {
      const input = objectField(variables, "input");
      const [projectId, environmentId, serviceId, name, value] = [
        input.projectId,
        input.environmentId,
        input.serviceId,
        input.name,
        input.value,
      ].map(String);
      const project = fake.projects[projectId ?? ""];
      const reaches =
        project?.environments.some((e) => e.id === environmentId && e.canAccess !== false) &&
        project.services.some((s) => s.id === serviceId) &&
        (!token || (token.projectId === projectId && token.environmentId === environmentId));
      if (!reaches) return refuse();
      if (fake.failWrites) return refuse(`could not store ${value} for ${name}`);
      values.set(`${environmentId}/${serviceId}/${name}`, value ?? "");
      effects.push(`railway set ${projectId}/${environmentId}/${serviceId} ${name}`);
      if (input.skipDeploys !== true) effects.push(`railway deploy ${serviceId}`);
      return reply({ data: { variableUpsert: true } });
    }
    return reply({ errors: [{ message: "Cannot query field" }], data: null }, 400);
  };

  return {
    fetch,
    effects,
    value: (environmentId: string, serviceId: string, name: string) =>
      values.get(`${environmentId}/${serviceId}/${name}`),
  };
}
