import { type Fetch, isRecord } from "@keypin/core";

export interface FakeGitLabVariable {
  key: string;
  environmentScope: string;
  masked: boolean;
  hidden: boolean;
  protected: boolean;
  raw: boolean;
}

export interface FakeGitLabToken {
  user: string;
  scopes: string[];
  reaches: Record<string, "member" | "admin">;
  personal?: boolean;
}

export interface FakeGitLab {
  host?: string;
  tokens: Record<string, FakeGitLabToken>;
  variables?: Record<string, FakeGitLabVariable[]>;
  pageSize?: number;
  failWrites?: boolean;
}

const REST = /^\/api\/v4\/(projects|groups)\/([^/]+)\/variables(?:\/([^/]+))?$/;

export function gitlabFetch(fake: FakeGitLab) {
  const values = new Map<string, string>();
  const effects: string[] = [];
  const requests: { method: string; path: string; body: string }[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const listOf = (path: string) => ((fake.variables ??= {})[path.toLowerCase()] ??= []);

  const fetch: Fetch = async (url, init) => {
    const { host, pathname, searchParams } = new URL(url);
    requests.push({
      method: init.method,
      path: `${pathname}${new URL(url).search}`,
      body: init.body ?? "",
    });
    if (host !== (fake.host ?? "gitlab.com")) return reply(404, { message: "wrong host" });
    const auth = init.headers.Authorization ?? "";
    const token = auth.startsWith("Bearer ") ? fake.tokens[auth.slice(7)] : undefined;
    if (!token) return reply(401, { message: "401 Unauthorized" });
    const sent: unknown = JSON.parse(init.body ?? "null");
    const body = isRecord(sent) ? sent : {};
    const access = (path: string) => token.reaches[path.toLowerCase()];

    if (pathname === "/api/v4/personal_access_tokens/self" && init.method === "GET")
      return token.personal === false
        ? reply(404, { message: "404 Not Found" })
        : reply(200, { name: "keypin", scopes: token.scopes, active: true });

    if (pathname === "/api/graphql" && init.method === "POST") {
      if (!token.scopes.includes("api") && !token.scopes.includes("read_api"))
        return reply(403, { error: "insufficient_scope" });
      const query = typeof body.query === "string" ? body.query : "";
      const vars = isRecord(body.variables) ? body.variables : {};
      const owner = query.includes("group(fullPath") ? "group" : "project";
      const path = typeof vars.path === "string" ? vars.path : "";
      const reach = access(path);
      const node =
        reach === undefined
          ? null
          : {
              ciVariables:
                reach === "admin" ? page(listOf(path), vars.after, fake.pageSize ?? 100) : null,
            };
      return reply(200, { data: { currentUser: { username: token.user }, [owner]: node } });
    }

    const [, kind = "", rawPath = "", rawKey] = REST.exec(pathname) ?? [];
    const path = decodeURIComponent(rawPath);
    if (!kind) return reply(404, { message: "404 Not Found" });
    if (access(path) === undefined) return reply(404, { message: "404 Project Not Found" });
    if (access(path) !== "admin" || !token.scopes.includes("api"))
      return reply(403, { message: "403 Forbidden" });
    const value = typeof body.value === "string" ? body.value : "";
    if (fake.failWrites) return reply(400, { message: { value: [`${value} is invalid`] } });
    const list = listOf(path);
    const scope =
      kind === "groups"
        ? "*"
        : typeof body.environment_scope === "string"
          ? body.environment_scope
          : (searchParams.get("filter[environment_scope]") ?? "*");

    if (init.method === "POST" && rawKey === undefined) {
      const key = String(body.key);
      if (list.some((v) => v.key === key && v.environmentScope === scope))
        return reply(400, { message: { key: [`(${key}) has already been taken`] } });
      const hidden = body.masked_and_hidden === true;
      const made: FakeGitLabVariable = {
        key,
        environmentScope: scope,
        masked: hidden || body.masked === true,
        hidden,
        protected: body.protected === true,
        raw: body.raw !== false,
      };
      list.push(made);
      values.set(`${path}#${scope}:${key}`, value);
      effects.push(`gitlab create ${kind} ${path} ${key}`);
      return reply(201, { ...made, value: hidden ? null : value });
    }
    if (init.method === "PUT" && rawKey !== undefined) {
      const key = decodeURIComponent(rawKey);
      const filter = searchParams.get("filter[environment_scope]");
      const found = list.filter(
        (v) => v.key === key && (filter === null || v.environmentScope === filter),
      );
      const [target] = found.length ? found : list.filter((v) => v.key === key);
      if (!target) return reply(404, { message: "404 Variable Not Found" });
      if (body.masked === true) target.masked = true;
      values.set(`${path}#${target.environmentScope}:${key}`, value);
      effects.push(`gitlab update ${kind} ${path} ${key}`);
      return reply(200, { ...target, value: target.hidden ? null : value });
    }
    return reply(405, { message: "405 Method Not Allowed" });
  };

  return {
    fetch,
    effects,
    requests,
    variables: (path: string) => fake.variables?.[path.toLowerCase()] ?? [],
    value: (path: string, key: string, scope = "*") => values.get(`${path}#${scope}:${key}`),
  };
}

function page(list: FakeGitLabVariable[], after: unknown, size: number) {
  const from = typeof after === "string" ? Number(after) : 0;
  const nodes = list.slice(from, from + size);
  const next = from + size < list.length;
  return { nodes, pageInfo: { hasNextPage: next, endCursor: next ? String(from + size) : null } };
}
