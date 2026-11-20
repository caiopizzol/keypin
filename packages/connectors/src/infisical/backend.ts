import {
  type Day,
  type Fetch,
  HeldForApproval,
  type IdToken,
  isRecord,
  type KeyRef,
  messageOf,
  NoIdToken,
  parseDay,
  parseObject,
  Secret,
  SignInFailed,
  type VaultBackend,
  type VaultItem,
  type VaultScope,
} from "@keypin/core";
import {
  account,
  decode,
  decodeScope,
  describe as describeRef,
  format,
  type InfisicalPin as Place,
  type InfisicalRef,
  type InfisicalScope as Scope,
} from "./reference";

export const CLIENT_ID = "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID";
export const CLIENT_SECRET = "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET";
export const ACCESS_TOKENS = ["INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN", "INFISICAL_TOKEN"];
export const IDENTITY_ID = "KEYPIN_INFISICAL_IDENTITY_ID";
export const AUDIENCE = "KEYPIN_INFISICAL_AUDIENCE";
const CONFIRMED_URL = "KEYPIN_INFISICAL_URL";
export const NO_CREDENTIALS = `set ${CLIENT_ID} and ${CLIENT_SECRET} to a machine identity's Universal Auth client ID and secret, or ${ACCESS_TOKENS.join(" or ")} to a machine identity's access token`;
const ANOTHER_WAY = `or unset ${IDENTITY_ID} to sign in another way`;
export const NO_JOB_TOKEN = `give the GitHub Actions job permissions: id-token: write, ${ANOTHER_WAY}`;
const ROTATED = "rotated";
const CLOUD = ["https://app.infisical.com", "https://us.infisical.com", "https://eu.infisical.com"];
const LONGEST_TTL_SECONDS = 3600;
const REVOKE_WAIT_MS = 5000;

export type Credentials =
  | { clientId: string; clientSecret: string }
  | { token: string; variable: string }
  | { identityId: string; audience: string | null; confirmedUrl: string | null }
  | { problem: string };

export interface InfisicalOptions {
  sleep?: (ms: number) => Promise<void>;
  idToken?: IdToken;
  warn?: (text: string) => void;
}

type Json = Record<string, unknown>;

interface Session {
  place: Place;
  token: string;
  minted: boolean;
  projects: Map<string, Promise<string>>;
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function credentialsFrom(
  env: Readonly<Record<string, string | undefined>>,
): Credentials | null {
  const identityId = env[IDENTITY_ID] ?? "";
  if (identityId) {
    const others = [CLIENT_ID, CLIENT_SECRET, ...ACCESS_TOKENS].filter((name) => env[name]);
    const listed = others.join(" and ");
    if (others.length)
      return {
        problem: `both ${IDENTITY_ID} and ${listed} are set; unset ${listed} to sign in with GitHub Actions OIDC, or ${IDENTITY_ID} to sign in with ${others.length === 1 ? "it" : "them"}`,
      };
    return {
      identityId,
      audience: env[AUDIENCE] || null,
      confirmedUrl: env[CONFIRMED_URL] || null,
    };
  }
  const clientId = env[CLIENT_ID] ?? "";
  const clientSecret = env[CLIENT_SECRET] ?? "";
  if (clientId && clientSecret) return { clientId, clientSecret };
  const variable = ACCESS_TOKENS.find((name) => env[name]);
  const token = variable === undefined ? undefined : env[variable];
  return variable && token ? { token, variable } : null;
}

const LONGEST_WAIT_SECONDS = 60;

export function infisicalBackend(
  credentials: Credentials | null,
  fetch: Fetch = globalThis.fetch,
  options: InfisicalOptions = {},
): VaultBackend {
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const warn = options.warn ?? (() => {});
  const sessions = new Map<string, Promise<Session>>();
  const strict = credentials !== null && "identityId" in credentials;

  async function request(
    place: Place,
    method: string,
    path: string,
    options: {
      token?: string;
      body?: Json;
      query?: Record<string, string>;
      signIn?: boolean;
      always?: boolean;
    } = {},
  ): Promise<{ status: number; body: Json }> {
    const fail = (why: string) =>
      options.signIn
        ? new SignInFailed(`${account(place)}: sign-in failed: ${why}`, { kind: "other" })
        : new Error(`${account(place)}: ${why}`);
    const query = options.query ? `?${new URLSearchParams(options.query)}` : "";
    const send = () =>
      fetch(`${place.url}${path}${query}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        ...(strict ? { redirect: "error" as const } : {}),
      });
    let response = await send();
    const wait = Number(response.headers.get("Retry-After"));
    if (response.status === 429 && wait > 0 && wait <= LONGEST_WAIT_SECONDS) {
      await response.text();
      await sleep(wait * 1000);
      response = await send();
    }
    const body = parseObject(await response.text());
    if (typeof body.message === "string")
      body.message = [
        options.token,
        options.body?.jwt,
        options.body?.clientSecret,
        options.body?.secretValue,
      ].reduce<string>(
        (text, secret) => (typeof secret === "string" && secret ? hidden(text, secret) : text),
        body.message,
      );
    if (response.status === 404 && body.error === "Not Found")
      throw fail(
        options.always
          ? `the server has no ${method} ${path}; check that url in keypin.toml points to the Infisical server itself, with no path`
          : `the server has no ${method} ${path}, so it may be older than keypin supports; keypin needs Infisical from September 2025 or later`,
      );
    if (response.status === 429)
      throw fail(
        `Infisical is limiting how often keypin can ask (${problem({ status: response.status, body })}); wait, then run the command again`,
      );
    return { status: response.status, body };
  }

  async function signIn(place: Place): Promise<Session> {
    const where = account(place);
    if (!credentials)
      throw new SignInFailed(`${where}: sign-in failed: ${NO_CREDENTIALS}`, {
        kind: "no-credentials",
      });
    if ("problem" in credentials)
      throw new SignInFailed(`${where}: sign-in failed: ${credentials.problem}`, { kind: "other" });
    const minted = "identityId" in credentials;
    const token = await accessToken(place, credentials);
    try {
      await checkIdentity(place, token, credentials);
    } catch (error) {
      if (minted) await revoke(place, token);
      throw error;
    }
    return { place, token, minted, projects: new Map() };
  }

  async function checkIdentity(place: Place, token: string, credentials: Credentials) {
    const where = account(place);
    const details = await request(place, "GET", "/api/v1/identities/details", {
      token,
      signIn: true,
    });
    if ("variable" in credentials && (details.status === 401 || details.status === 403))
      throw new SignInFailed(
        details.status === 401
          ? `${where}: sign-in failed: Infisical refused the access token in ${credentials.variable} (HTTP 401); it may have expired, so get a new one`
          : `${where}: sign-in failed: the access token in ${credentials.variable} isn't a machine identity's; use a machine identity's access token`,
        { kind: "other" },
      );
    const identity = details.body.identityDetails;
    const organization =
      isRecord(identity) && isRecord(identity.organization) ? identity.organization.slug : null;
    if (details.status !== 200 || typeof organization !== "string")
      throw new SignInFailed(
        `${where}: sign-in failed: couldn't read the machine identity's organization (${problem(details)}); a machine identity created in a sub-organization has none keypin can check, so use one from the top-level organization`,
        { kind: "other" },
      );
    if (organization !== place.organization)
      throw new SignInFailed(
        `${where}: sign-in failed: the machine identity belongs to the organization ${organization}, but keypin.toml pins ${place.organization}; keypin reads only from top-level organizations, not sub-organizations`,
        { kind: "wrong-account", pinned: place.organization, actual: organization },
      );
  }

  async function accessToken(
    place: Place,
    given: Exclude<Credentials, { problem: string }>,
  ): Promise<string> {
    if ("token" in given) return given.token;
    if ("identityId" in given) return oidcToken(place, given);
    const login = await request(place, "POST", "/api/v1/auth/universal-auth/login", {
      body: { clientId: given.clientId, clientSecret: given.clientSecret },
      signIn: true,
      always: true,
    });
    const token = login.body.accessToken;
    if (login.status !== 200 || typeof token !== "string")
      throw new SignInFailed(`${account(place)}: sign-in failed: ${problem(login)}`, {
        kind: "other",
      });
    return token;
  }

  async function oidcToken(
    place: Place,
    given: { identityId: string; audience: string | null; confirmedUrl: string | null },
  ): Promise<string> {
    const failed = (why: string, kind: "no-credentials" | "other" = "other") =>
      new SignInFailed(`${account(place)}: sign-in failed: ${why}`, { kind });
    if (!CLOUD.includes(place.url) && originOf(given.confirmedUrl) !== place.url)
      throw failed(
        `keypin sends GitHub's OIDC token only to Infisical Cloud, and keypin.toml's url is ${place.url}; if that server is yours, set ${CONFIRMED_URL}=${place.url} in the job`,
      );
    const idToken =
      options.idToken ??
      (() => Promise.reject(new NoIdToken("keypin has no way to ask for an OIDC token here")));
    let jwt: string;
    try {
      jwt = await idToken(given.audience);
    } catch (error) {
      throw error instanceof NoIdToken
        ? failed(`${IDENTITY_ID} is set, but ${error.message}, ${ANOTHER_WAY}`, "no-credentials")
        : failed(`couldn't get GitHub Actions' OIDC token: ${messageOf(error)}`);
    }
    const login = await request(place, "POST", "/api/v1/auth/oidc-auth/login", {
      body: { identityId: given.identityId, jwt },
      signIn: true,
      always: true,
    });
    const token = login.body.accessToken;
    if (login.status !== 200 || typeof token !== "string" || !token) {
      const audience = given.audience ?? "GitHub's default audience, https://github.com/<owner>";
      throw failed(
        `Infisical refused GitHub's OIDC token for the machine identity ${given.identityId} (${problem(login)}); keypin asked GitHub for a token for ${audience}, so check that the identity's OIDC Auth lists it under Audiences and that its subject matches this job`,
      );
    }
    const lives = [login.body.expiresIn, login.body.accessTokenMaxTTL].filter(
      (seconds) => typeof seconds === "number",
    );
    if (lives.some((seconds) => seconds > LONGEST_TTL_SECONDS))
      warn(
        `the Infisical machine identity ${given.identityId} gives out access tokens that last more than an hour; set its Access Token TTL and Access Token Max TTL to a few minutes`,
      );
    return token;
  }

  async function revoke(place: Place, token: string): Promise<void> {
    let why: string | null;
    try {
      const response = await fetch(`${place.url}/api/v1/auth/token/revoke`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token }),
        redirect: "error",
        signal: AbortSignal.timeout(REVOKE_WAIT_MS),
      });
      why =
        response.status === 200
          ? null
          : problem({ status: response.status, body: parseObject(await response.text()) });
    } catch (error) {
      why = messageOf(error);
    }
    if (why !== null)
      warn(
        `${account(place)}: couldn't revoke keypin's access token (${hidden(why, token)}); it lasts until its TTL runs out`,
      );
  }

  function session(place: Place): Promise<Session> {
    const key = account(place);
    let pending = sessions.get(key);
    if (!pending) {
      pending = signIn(place);
      sessions.set(key, pending);
    }
    return pending;
  }

  function projectId(place: Place, current: Session, project: string): Promise<string> {
    if (PROJECT_ID.test(project)) return Promise.resolve(project);
    let pending = current.projects.get(project);
    if (!pending) {
      pending = request(place, "GET", `/api/v1/projects/slug/${encodeURIComponent(project)}`, {
        token: current.token,
      }).then((found) => {
        if (found.status === 200 && typeof found.body.id === "string") return found.body.id;
        throw new Error(
          found.status === 404
            ? `${account(place)}: no project with the slug "${project}", or the machine identity isn't a member`
            : `${account(place)}: couldn't find the project "${project}": ${problem(found)}`,
        );
      });
      current.projects.set(project, pending);
    }
    return pending;
  }

  async function secretOf(
    ref: InfisicalRef,
    view: { value: boolean; imports: boolean; expand: boolean },
  ): Promise<{ secret: Json; project: string } | string> {
    const current = await session(ref);
    const project = await projectId(ref, current, ref.project);
    const found = await request(ref, "GET", `/api/v4/secrets/${encodeURIComponent(ref.name)}`, {
      token: current.token,
      query: {
        projectId: project,
        environment: ref.environment,
        secretPath: ref.path,
        viewSecretValue: String(view.value),
        expandSecretReferences: String(view.expand),
        includeImports: String(view.imports),
      },
    });
    if (found.status === 404) return problem(found);
    if (found.status !== 200 || !isRecord(found.body.secret))
      throw new Error(`${describeRef(ref)}: ${problem(found)}`);
    return { secret: found.body.secret, project };
  }

  async function existing(ref: InfisicalRef, value: boolean) {
    const found = await secretOf(ref, { value, imports: true, expand: true });
    if (typeof found === "string") throw new Error(`${describeRef(ref)}: ${found}`);
    return found;
  }

  async function ownSecret(ref: InfisicalRef) {
    const local = await secretOf(ref, { value: true, imports: false, expand: false });
    if (typeof local === "string") {
      const imported = await secretOf(ref, { value: false, imports: true, expand: false });
      if (typeof imported !== "string")
        throw new Error(
          fromElsewhere(ref, "is imported from", [importSource(ref, imported.secret)]),
        );
      return null;
    }
    const raw = local.secret.secretValueHidden === true ? null : local.secret.secretValue;
    if (typeof raw !== "string")
      throw new Error(
        `${describeRef(ref)}: the machine identity can see this secret but not its value, so keypin can't tell whether it references another secret`,
      );
    const sources = referencedBy(ref, raw);
    if (sources.length) throw new Error(fromElsewhere(ref, "references", sources));
    return local;
  }

  async function valueOf(ref: InfisicalRef) {
    const { secret, project } = await existing(ref, true);
    if (secret.secretValueHidden === true || typeof secret.secretValue !== "string")
      throw new Error(
        `${describeRef(ref)}: the machine identity can see this secret but not its value`,
      );
    if (secret.secretValue === "") throw new Error(`${describeRef(ref)}: the value is empty`);
    return { secret: new Secret(secret.secretValue), ids: idsOf(secret, project) };
  }

  return {
    async read(given) {
      return (await valueOf(own(given))).secret;
    },

    async readItem(given) {
      return valueOf(own(given));
    },

    async itemIds(given) {
      const { secret, project } = await existing(own(given), false);
      return idsOf(secret, project);
    },

    async write(given, value, options = {}) {
      const ref = own(given);
      const rotated = options.rotated;
      const found = await ownSecret(ref);
      if (found && options.newItem)
        throw new Error(
          `${describeRef(ref)}: the secret already exists; keypin doesn't overwrite it`,
        );
      const current = await session(ref);
      const project = found?.project ?? (await projectId(ref, current, ref.project));
      const metadata = withRotated(found ? metadataOf(found.secret) : [], rotated);
      const written = await request(
        ref,
        found ? "PATCH" : "POST",
        `/api/v4/secrets/${encodeURIComponent(ref.name)}`,
        {
          token: current.token,
          body: {
            projectId: project,
            environment: ref.environment,
            secretPath: ref.path,
            secretValue: value.reveal(),
            ...(rotated === undefined ? {} : { secretMetadata: metadata }),
          },
        },
      );
      if (written.status === 200 && isRecord(written.body.approval))
        throw new HeldForApproval(
          `${describeRef(ref)}: Infisical holds the change for approval; the secret keeps its old value until someone approves it`,
        );
      if (written.status !== 200 || !isRecord(written.body.secret))
        throw new Error(`${describeRef(ref)}: ${problem(written)}`);
    },

    async checkWrite(given) {
      await ownSecret(own(given));
    },

    async list(given) {
      const scope = ownScope(given);
      const current = await session(scope);
      const project = await projectId(scope, current, scope.project);
      const found = await request(scope, "GET", "/api/v4/secrets", {
        token: current.token,
        query: {
          projectId: project,
          environment: scope.environment,
          secretPath: scope.path,
          viewSecretValue: "false",
          expandSecretReferences: "false",
          includeImports: "false",
        },
      });
      if (found.status !== 200 || !Array.isArray(found.body.secrets))
        throw new Error(`${account(scope)}: couldn't list ${scope.project}: ${problem(found)}`);
      return found.body.secrets.filter(isRecord).map((secret): VaultItem => ({
        id: String(secret.id),
        title: String(secret.secretKey),
        tags: Array.isArray(secret.tags)
          ? secret.tags.flatMap((tag) =>
              isRecord(tag) && typeof tag.slug === "string" ? [tag.slug] : [],
            )
          : [],
        updatedAt: String(secret.updatedAt),
      }));
    },

    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(
        open.map(async (pending) => {
          const current = await pending.catch(() => null);
          if (current?.minted) await revoke(current.place, current.token);
        }),
      );
    },

    async metadata(given) {
      const ref = own(given);
      const { secret } = await existing(ref, false);
      const value = metadataOf(secret).find((entry) => entry.key === ROTATED)?.value ?? "";
      if (value === "") return { rotated: null };
      const rotated = parseDay(value);
      if (!rotated)
        throw new Error(
          `${describeRef(ref)}: the metadata "${ROTATED}" isn't a YYYY-MM-DD date: "${value}"`,
        );
      return { rotated };
    },
  };
}

function own(ref: KeyRef): InfisicalRef {
  const mine = decode(ref);
  if (!mine)
    throw new Error(`keypin's Infisical vault can't read this reference, which is for ${ref.kind}`);
  return mine;
}

function ownScope(scope: VaultScope): Scope {
  const mine = decodeScope(scope);
  if (!mine) throw new Error(`keypin's Infisical vault can't list ${scope.kind} items`);
  return mine;
}

function fromElsewhere(ref: InfisicalRef, how: string, sources: readonly string[]): string {
  const [only] = sources;
  const source = sources.length === 1 && only ? only : "the source secret";
  return `${describeRef(ref)}: the secret ${how} ${sources.join(" and ")}, so a new key saved here would leave that secret, and everything that uses it, with the old key; point keypin.toml at ${source} instead`;
}

function importSource(ref: InfisicalRef, secret: Json): string {
  const { environment, secretPath } = secret;
  if (typeof environment !== "string" || typeof secretPath !== "string")
    return "another environment or folder";
  return format({ ...ref, environment, path: secretPath });
}

const REFERENCE = /\$\{([a-zA-Z0-9-_.@]+(?: +[a-zA-Z0-9-_@]+)*)\}/g;

function referencedBy(ref: InfisicalRef, raw: string): string[] {
  return [
    ...new Set([...raw.matchAll(REFERENCE)].map(([, inner = ""]) => referenceTo(ref, inner))),
  ];
}

function referenceTo(ref: InfisicalRef, inner: string): string {
  const parts = inner.split(".");
  const project = parts[0]?.startsWith("@") ? parts.shift()?.slice(1) : undefined;
  const name = parts.pop() ?? "";
  const [environment, ...folders] = parts;
  const place = project === undefined ? ref : { ...ref, project };
  if (environment === undefined) return format({ ...place, name });
  return format({ ...place, environment, path: `/${folders.join("/")}`, name });
}

function idsOf(secret: Json, project: string) {
  return { vault: project, item: String(secret.id) };
}

interface Metadata {
  key: string;
  value: string;
  isEncrypted?: boolean;
}

function metadataOf(secret: Json): Metadata[] {
  const list = secret.secretMetadata;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): Metadata[] =>
    isRecord(entry) && typeof entry.key === "string"
      ? [
          {
            key: entry.key,
            value: typeof entry.value === "string" ? entry.value : "",
            ...(typeof entry.isEncrypted === "boolean" ? { isEncrypted: entry.isEncrypted } : {}),
          },
        ]
      : [],
  );
}

function withRotated(metadata: Metadata[], rotated: Day | undefined): Metadata[] {
  if (rotated === undefined) return metadata;
  return [
    ...metadata.filter((entry) => entry.key !== ROTATED),
    { key: ROTATED, value: rotated, isEncrypted: true },
  ];
}

function originOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

function hidden(text: string, secret: string): string {
  return text.replaceAll(secret, "[hidden]");
}

function problem(response: { status: number; body: Json }): string {
  const message = typeof response.body.message === "string" ? `: ${response.body.message}` : "";
  return `Infisical returned HTTP ${response.status}${message}`;
}
