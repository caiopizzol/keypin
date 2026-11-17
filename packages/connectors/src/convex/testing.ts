import { type Fetch, isRecord } from "@keypin/core";

export interface FakeConvex {
  deployments: Record<string, { host: string }>;
  keys: Record<string, { deployment: string; envWrite: boolean }>;
  failWrites?: boolean;
}

const ROUTE = /^\/api\/v1\/(get_canonical_urls|update_environment_variables)$/;

export function convexFetch(fake: FakeConvex) {
  const values = new Map<string, string>();
  const effects: string[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const refuse = (status: number, code: string, message: string) =>
    reply(status, { code, message });

  const fetch: Fetch = async (url, init) => {
    const { hostname, pathname } = new URL(url);
    const [name, deployment] =
      Object.entries(fake.deployments).find(([, d]) => d.host === hostname) ?? [];
    if (!name || !deployment) return refuse(404, "NotFound", "No such deployment");
    const auth = init.headers.Authorization ?? "";
    if (!auth.startsWith("Convex ")) return refuse(401, "Unauthenticated", "No key");
    const key = fake.keys[auth.slice("Convex ".length)];
    if (!key) return refuse(401, "Unauthenticated", "The provided deploy key was invalid");
    if (key.deployment !== name)
      return refuse(
        403,
        "BadDeployKey",
        `The provided deploy key was invalid for deployment '${name}'`,
      );

    const [, route] = ROUTE.exec(pathname) ?? [];
    if (route === "get_canonical_urls" && init.method === "GET")
      return reply(200, {
        convexCloudUrl: `https://${hostname}`,
        convexSiteUrl: `https://${name}.convex.site`,
      });
    if (route !== "update_environment_variables" || init.method !== "POST")
      return refuse(404, "NotFound", "No such route");
    if (!key.envWrite)
      return refuse(
        403,
        "OperationNotPermitted",
        "You do not have permission to perform this operation (deployment:env:write).",
      );
    const sent: unknown = JSON.parse(init.body ?? "null");
    const changes = isRecord(sent) && Array.isArray(sent.changes) ? sent.changes : [];
    if (fake.failWrites)
      return refuse(400, "EnvironmentVariableValueTooLarge", `could not store ${init.body ?? ""}`);
    for (const change of changes.filter(isRecord)) {
      const variable = String(change.name);
      values.set(`${name}/${variable}`, String(change.value));
      effects.push(`convex set ${name} ${variable}`);
    }
    return new Response(null, { status: 200 });
  };

  return {
    fetch,
    effects,
    value: (deployment: string, name: string) => values.get(`${deployment}/${name}`),
  };
}
