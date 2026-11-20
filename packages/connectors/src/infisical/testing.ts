import { type Fetch, isRecord } from "@keypin/core";

const INFISICAL_TOKEN = "infisical-access-token-5d8e";
export const OIDC_ACCESS_TOKEN = "infisical-oidc-access-token-8b1f";

export interface FakeMetadata {
  key: string;
  value: string;
  isEncrypted?: boolean;
}

export interface FakeSecret {
  value: string;
  rotated?: string;
  id?: string;
  tags?: string[];
  metadata?: FakeMetadata[];
}

type Projects = Record<string, Record<string, Record<string, FakeSecret>>>;

export interface FakeInfisical {
  organization: string;
  projects: Projects;
  projectIds?: Record<string, string>;
  imports?: FakeImport[];
  heldByPolicy?: Stored[];
  failWrites?: boolean;
  refuseLogin?: number;
  accessToken?: string;
  userToken?: string;
  missingRoutes?: string[];
  rateLimited?: { times: number; retryAfter?: number };
  hideValues?: boolean;
  requireEncryptedMetadata?: boolean;
  oidc?: { identityId: string; jwt: string; expiresIn?: number; accessTokenMaxTTL?: number };
  revoked?: string[];
}

export interface FakeImport {
  into: string;
  environment: string;
  path?: string;
}

export interface Stored {
  project: string;
  environment: string;
  path?: string;
  name: string;
  secret: FakeSecret;
}

export interface Store {
  load(): Stored[];
  save(entry: Stored): void;
  effect(line: string): void;
}

const ROOT = "/";
const ROTATED = "rotated";
const REFERENCE = /\$\{([a-zA-Z0-9-_.@]+(?: +[a-zA-Z0-9-_@]+)*)\}/g;
const pathOf = (key: string) => {
  const slash = key.lastIndexOf("/");
  return slash <= 0 ? ROOT : key.slice(0, slash);
};
const nameOf = (key: string) => key.slice(key.lastIndexOf("/") + 1);
const sameSecret = (a: Stored, b: Stored) =>
  a.project === b.project &&
  a.environment === b.environment &&
  (a.path ?? ROOT) === (b.path ?? ROOT) &&
  a.name === b.name;

export function infisicalFetch(fake: FakeInfisical, store: Store): Fetch {
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const idOf = (slug: string) => fake.projectIds?.[slug] ?? slug;
  const slugOf = (id: string) =>
    Object.entries(fake.projectIds ?? {}).find(([, known]) => known === id)?.[0] ?? id;
  const secretsOf = (project: string, environment: string, path: string) => {
    const base = Object.entries(fake.projects[project]?.[environment] ?? {})
      .filter(([key]) => pathOf(key) === path)
      .map(([key, secret]): [string, FakeSecret] => [nameOf(key), secret]);
    const added = store
      .load()
      .filter(
        (s) => s.project === project && s.environment === environment && (s.path ?? ROOT) === path,
      );
    return {
      ...Object.fromEntries(base),
      ...Object.fromEntries(added.map((s) => [s.name, s.secret])),
    };
  };
  const folderExists = (project: string, environment: string, path: string) => {
    const keys = [
      ...Object.keys(fake.projects[project]?.[environment] ?? {}),
      ...store
        .load()
        .filter((s) => s.project === project && s.environment === environment)
        .map((s) => `${s.path ?? ROOT}/${s.name}`),
    ];
    if (!fake.projects[project]?.[environment]) return false;
    return path === ROOT || keys.some((key) => `${pathOf(key)}/`.startsWith(`${path}/`));
  };
  return async (url, init) => {
    const parsed = new URL(url);
    if (fake.rateLimited && fake.rateLimited.times > 0) {
      fake.rateLimited.times--;
      const wait = fake.rateLimited.retryAfter ?? 42;
      return new Response(
        JSON.stringify({
          statusCode: 429,
          message: `Rate limit exceeded. Please try again in ${wait} seconds`,
          error: "RateLimitExceeded",
        }),
        {
          status: 429,
          headers:
            fake.rateLimited.retryAfter === undefined
              ? {}
              : { "Retry-After": String(fake.rateLimited.retryAfter) },
        },
      );
    }
    if (fake.missingRoutes?.some((route) => parsed.pathname.startsWith(route)))
      return reply(404, {
        statusCode: 404,
        message: `Route ${init.method}:${parsed.pathname} not found`,
        error: "Not Found",
      });
    const sent: unknown = init.body ? JSON.parse(init.body) : null;
    const body = isRecord(sent) ? sent : {};
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const query = Object.fromEntries(parsed.searchParams);
    if (parsed.pathname === "/api/v1/auth/universal-auth/login")
      return fake.refuseLogin
        ? reply(fake.refuseLogin, { message: "Invalid credentials" })
        : reply(200, { accessToken: INFISICAL_TOKEN, expiresIn: 7200, tokenType: "Bearer" });
    if (parsed.pathname === "/api/v1/auth/oidc-auth/login")
      return fake.oidc && body.identityId === fake.oidc.identityId && body.jwt === fake.oidc.jwt
        ? reply(200, {
            accessToken: OIDC_ACCESS_TOKEN,
            expiresIn: fake.oidc.expiresIn ?? 300,
            accessTokenMaxTTL: fake.oidc.accessTokenMaxTTL ?? 300,
            tokenType: "Bearer",
          })
        : reply(401, { message: "Access denied: OIDC audience not allowed." });
    if (parsed.pathname === "/api/v1/auth/token/revoke") {
      if (typeof body.accessToken !== "string") return reply(400, { message: "Bad request" });
      (fake.revoked ??= []).push(body.accessToken);
      return reply(200, { message: "Successfully revoked access token" });
    }
    const bearer = init.headers.Authorization?.replace(/^Bearer /, "");
    const minted = fake.oidc ? [OIDC_ACCESS_TOKEN] : [];
    if (
      bearer === undefined ||
      fake.revoked?.includes(bearer) ||
      ![INFISICAL_TOKEN, fake.accessToken, fake.userToken, ...minted].includes(bearer)
    )
      return reply(401, { message: "Unauthorized" });
    const user = bearer === fake.userToken;
    if (parsed.pathname === "/api/v1/identities/details" && user)
      return reply(403, { message: "Forbidden access to /api/v1/identities/details" });
    if (parsed.pathname === "/api/v1/identities/details")
      return reply(200, {
        identityDetails: {
          organization: { id: "org", name: fake.organization, slug: fake.organization },
        },
      });
    const slug = /^\/api\/v1\/projects\/slug\/(.+)$/.exec(parsed.pathname)?.[1];
    if (slug !== undefined)
      return fake.projects[slug]
        ? reply(200, { id: idOf(slug), slug })
        : reply(404, { message: "Project not found" });
    const name = decodeURIComponent(parsed.pathname.replace(/^\/api\/v4\/secrets\/?/, ""));
    const project = slugOf(query.projectId ?? text(body.projectId));
    const environment = query.environment ?? text(body.environment);
    const path = query.secretPath ?? (text(body.secretPath) || ROOT);
    if (!folderExists(project, environment, path))
      return reply(404, {
        statusCode: 404,
        message: `Folder with path '${path}' in environment with slug '${environment}' not found`,
        error: "GetSecretByName",
      });
    const secrets = secretsOf(project, environment, path);
    const imported =
      query.includeImports !== "false" && !secrets[name]
        ? fake.imports
            ?.flatMap((from) => {
              if (from.into !== environment) return [];
              const secret = secretsOf(project, from.environment, from.path ?? ROOT)[name];
              return secret ? [{ secret, from }] : [];
            })
            .at(-1)
        : undefined;
    const found = secrets[name];
    const expand = (
      raw: string,
      here: { environment: string; path: string },
      from: { environment: string; path: string },
      seen: Set<string>,
    ): string =>
      raw.replace(REFERENCE, (_, inner: string) => {
        const parts = inner.split(".");
        const target = parts[0]?.startsWith("@") ? (parts.shift()?.slice(1) ?? project) : project;
        const key = parts.pop() ?? "";
        const absolute = parts.length > 0;
        const [env = here.environment, ...folders] = parts;
        const folder = absolute ? `/${folders.join("/")}` : here.path;
        const places = absolute
          ? [{ environment: env, path: folder }]
          : [here, from].filter(
              (p, i, all) =>
                all.findIndex((q) => q.environment === p.environment && q.path === p.path) === i,
            );
        const withImports = places.flatMap((place) => [
          place,
          ...(target === project ? (fake.imports ?? []) : [])
            .filter((from) => from.into === place.environment)
            .map((from) => ({ environment: from.environment, path: from.path ?? ROOT }))
            .reverse(),
        ]);
        for (const place of withImports) {
          const id = `${target}/${place.environment}${place.path}/${key}`;
          const secret = secretsOf(target, place.environment, place.path)[key];
          if (!secret || seen.has(id)) continue;
          if (target !== project) return secret.value;
          const next = absolute ? place : here;
          return expand(secret.value, next, place, new Set([...seen, id]));
        }
        return "";
      });
    const shape = (key: string, secret: FakeSecret, value: boolean, at = { environment, path }) => {
      const shown = value && !fake.hideValues;
      const raw = secret.value;
      const expanded =
        query.expandSecretReferences === "false"
          ? raw
          : expand(
              raw,
              { environment, path },
              at,
              new Set([`${project}/${at.environment}${at.path}/${key}`]),
            );
      return {
        id: secret.id ?? `${project}/${at.environment}/${key}`,
        environment: at.environment,
        secretPath: at.path,
        secretKey: key,
        secretValue: shown ? expanded : "",
        secretValueHidden: !shown,
        secretMetadata: [
          ...(secret.metadata ?? []),
          ...(secret.rotated ? [{ key: ROTATED, value: secret.rotated }] : []),
        ],
        tags: (secret.tags ?? []).map((tag) => ({ id: tag, slug: tag, name: tag })),
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    };
    if (init.method === "GET" && name === "")
      return reply(200, {
        secrets: Object.entries(secrets).map(([key, secret]) =>
          shape(key, secret, query.viewSecretValue !== "false"),
        ),
      });
    if (init.method === "GET") {
      const view = query.viewSecretValue === "true";
      if (found) return reply(200, { secret: shape(name, found, view) });
      if (imported)
        return reply(200, {
          secret: shape(name, imported.secret, view, {
            environment: imported.from.environment,
            path: imported.from.path ?? ROOT,
          }),
        });
      return reply(404, { message: `Secret with name '${name}' not found` });
    }
    if (fake.failWrites) return reply(500, { message: "internal error" });
    const metadata = Array.isArray(body.secretMetadata)
      ? body.secretMetadata.flatMap((entry: unknown): FakeMetadata[] =>
          isRecord(entry) && typeof entry.key === "string" && typeof entry.value === "string"
            ? [{ key: entry.key, value: entry.value, isEncrypted: entry.isEncrypted === true }]
            : [],
        )
      : null;
    if (fake.requireEncryptedMetadata && metadata?.some((entry) => !entry.isEncrypted))
      return reply(400, { message: "Project requires all secret metadata to be encrypted" });
    const rotated = metadata
      ? metadata.find((entry) => entry.key === ROTATED)?.value
      : found?.rotated;
    const others = metadata
      ? metadata.filter((entry) => entry.key !== ROTATED)
      : (found?.metadata ?? []);
    const secret: FakeSecret = {
      value: text(body.secretValue),
      ...(rotated ? { rotated } : {}),
      ...(found?.id ? { id: found.id } : {}),
      ...(found?.tags ? { tags: found.tags } : {}),
      ...(others.length ? { metadata: others } : {}),
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

export function mergeHeld(fake: FakeInfisical, store: Pick<Store, "save">): void {
  for (const entry of fake.heldByPolicy?.splice(0) ?? []) store.save(entry);
}

export function memoryStore() {
  const saved: Stored[] = [];
  const effects: string[] = [];
  return {
    load: () => saved,
    save: (entry: Stored) => {
      const at = saved.findIndex((s) => sameSecret(s, entry));
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
    save: (entry) => write(JSON.stringify([...load().filter((s) => !sameSecret(s, entry)), entry])),
    effect,
  };
}

function isStored(entry: unknown): entry is Stored {
  return (
    isRecord(entry) &&
    typeof entry.project === "string" &&
    typeof entry.environment === "string" &&
    typeof entry.name === "string" &&
    isRecord(entry.secret) &&
    typeof entry.secret.value === "string"
  );
}
