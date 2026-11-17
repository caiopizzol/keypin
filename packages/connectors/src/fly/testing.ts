import { type Fetch, isRecord } from "@keypin/core";

export interface FakeFlyToken {
  org: string;
  apps?: string[];
  readOnly?: boolean;
}

export interface FakeFly {
  apps: Record<string, { org: string }>;
  tokens: Record<string, FakeFlyToken>;
  failWrites?: boolean;
}

const APP = /^\/v1\/apps\/([^/]+)$/;
const SECRET = /^\/v1\/apps\/([^/]+)\/secrets\/([^/]+)$/;

export function flyFetch(fake: FakeFly) {
  const values = new Map<string, string>();
  const effects: string[] = [];
  let version = 0;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const refuse = (status: number, error: string) => reply(status, { error });

  const fetch: Fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const auth = init.headers.Authorization ?? "";
    const token = auth.startsWith("Bearer ")
      ? fake.tokens[auth.slice("Bearer ".length)]
      : undefined;
    if (!token) return refuse(401, "unauthorized");
    const reaches = (app: string) =>
      fake.apps[app]?.org === token.org && (!token.apps || token.apps.includes(app));

    if (pathname === "/v1/tokens/current" && init.method === "GET")
      return reply(200, {
        tokens: [
          { org_slug: token.org, organization: token.org, token_id: "tok_1", apps: token.apps },
        ],
      });

    const [, appName] = APP.exec(pathname) ?? [];
    if (appName && init.method === "GET") {
      const app = decodeURIComponent(appName);
      if (!reaches(app)) return refuse(404, "app not found");
      return reply(200, { name: app, organization: { slug: fake.apps[app]?.org } });
    }

    const [, secretApp, secretName] = SECRET.exec(pathname) ?? [];
    if (secretApp && secretName && init.method === "POST") {
      const app = decodeURIComponent(secretApp);
      const name = decodeURIComponent(secretName);
      if (!reaches(app)) return refuse(404, "app not found");
      if (token.readOnly) return refuse(403, "unauthorized");
      const sent: unknown = JSON.parse(init.body ?? "null");
      const value = isRecord(sent) && typeof sent.value === "string" ? sent.value : "";
      if (fake.failWrites) return refuse(400, `could not set ${name}=${value}`);
      values.set(`${app}/${name}`, value);
      version += 1;
      effects.push(`fly set ${app} ${name}`);
      return reply(201, { name, value, digest: "d1g3st", version, Version: version });
    }
    return refuse(404, "not found");
  };

  return { fetch, effects, value: (app: string, name: string) => values.get(`${app}/${name}`) };
}
