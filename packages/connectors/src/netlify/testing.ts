import { type Fetch, isRecord } from "@keypin/core";

export interface FakeValue {
  context: string;
  context_parameter?: string;
}

export interface FakeVariable {
  key: string;
  is_secret: boolean;
  scopes: string[];
  values: FakeValue[];
}

export interface FakeNetlify {
  email: string | null;
  teams: Record<string, { id: string; projects: Record<string, string> }>;
  variables?: FakeVariable[];
  otherProjects?: Record<string, FakeVariable[]>;
  invalidToken?: boolean;
  failWrites?: boolean;
}

const SITE = /^\/api\/v1\/sites\/([^/]+)$/;
const ENV = /^\/api\/v1\/accounts\/([^/]+)\/env(?:\/([^/]+))?$/;

export function netlifyFetch(fake: FakeNetlify) {
  const values = new Map<string, string>();
  const effects: string[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const refuse = (status: number, message: string) => reply(status, { code: status, message });
  const sites = () =>
    Object.entries(fake.teams).flatMap(([slug, team]) =>
      Object.entries(team.projects).map(([domain, id]) => ({
        slug,
        accountId: team.id,
        domain,
        id,
      })),
    );

  const fetch: Fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (fake.invalidToken) return refuse(401, "Access Denied");
    if (pathname === "/api/v1/user")
      return fake.email === null
        ? refuse(401, "Access Denied")
        : reply(200, { email: fake.email, full_name: "Alice" });

    const [, wanted] = SITE.exec(pathname) ?? [];
    if (wanted) {
      const site = sites().find((s) => s.id === wanted || s.domain === decodeURIComponent(wanted));
      return site
        ? reply(200, {
            id: site.id,
            name: site.domain.split(".")[0],
            account_slug: site.slug,
            account_id: site.accountId,
          })
        : refuse(404, "Not Found");
    }

    const [, account = "", key] = ENV.exec(pathname) ?? [];
    const site = sites().find(
      (s) => s.slug === decodeURIComponent(account) && s.id === searchParams.get("site_id"),
    );
    if (!site) return refuse(404, "Not Found");
    const [home] = sites();
    const variables =
      site.id === home?.id
        ? (fake.variables ??= [])
        : ((fake.otherProjects ??= {})[site.domain] ??= []);
    const where = site.domain;

    if (init.method === "GET") return reply(200, variables);

    const sent: unknown = JSON.parse(init.body ?? "null");
    if (fake.failWrites) return refuse(400, `could not store ${JSON.stringify(sent)}`);

    if (init.method === "PATCH" && key) {
      const found = variables.find((v) => v.key === decodeURIComponent(key));
      if (!found || !isRecord(sent)) return refuse(404, "Not Found");
      const context = String(sent.context);
      const value = String(sent.value);
      if (!found.values.some((v) => v.context === context)) found.values.push({ context });
      values.set(`${found.key}/${context}`, value);
      effects.push(`netlify set ${where} ${found.key} ${context}`);
      return reply(201, { context, value: found.is_secret ? "" : value });
    }
    if (init.method === "POST" && Array.isArray(sent)) {
      const created = sent.filter(isRecord).map((each) => {
        const given = Array.isArray(each.values) ? each.values.filter(isRecord) : [];
        const variable: FakeVariable = {
          key: String(each.key),
          is_secret: each.is_secret === true,
          scopes: Array.isArray(each.scopes) ? each.scopes.map(String) : [],
          values: given.map((v) => ({ context: String(v.context) })),
        };
        if (variables.some((v) => v.key === variable.key)) return null;
        for (const v of given) values.set(`${variable.key}/${String(v.context)}`, String(v.value));
        variables.push(variable);
        effects.push(`netlify create ${where} ${variable.key}`);
        return variable;
      });
      return created.includes(null)
        ? refuse(400, "Environment variable already exists")
        : reply(201, created);
    }
    return refuse(405, "Method Not Allowed");
  };

  return {
    fetch,
    effects,
    variables: () => fake.variables ?? [],
    value: (key: string, context: string) => values.get(`${key}/${context}`),
  };
}
