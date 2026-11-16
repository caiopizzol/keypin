import {
  type Fetch,
  HeldForApproval,
  isDay,
  isRecord,
  type KeyRef,
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
  type InfisicalPin as Place,
  type InfisicalRef,
  type InfisicalScope as Scope,
} from "./reference";

export const CLIENT_ID = "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID";
export const CLIENT_SECRET = "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET";
const ROTATED = "rotated";

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

type Json = Record<string, unknown>;

interface Session {
  token: string;
  projects: Map<string, Promise<string>>;
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function credentialsFrom(
  env: Readonly<Record<string, string | undefined>>,
): Credentials | null {
  const clientId = env[CLIENT_ID] ?? "";
  const clientSecret = env[CLIENT_SECRET] ?? "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function infisicalBackend(
  credentials: Credentials | null,
  fetch: Fetch = globalThis.fetch,
): VaultBackend {
  const sessions = new Map<string, Promise<Session>>();

  async function request(
    place: Place,
    method: string,
    path: string,
    options: { token?: string; body?: Json; query?: Record<string, string> } = {},
  ): Promise<{ status: number; body: Json }> {
    const query = options.query ? `?${new URLSearchParams(options.query)}` : "";
    const response = await fetch(`${place.url}${path}${query}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }

  async function signIn(place: Place): Promise<Session> {
    const where = account(place);
    if (!credentials)
      throw new SignInFailed(
        `${where}: sign-in failed: set ${CLIENT_ID} and ${CLIENT_SECRET} to a machine identity's Universal Auth client ID and secret`,
        { kind: "no-credentials" },
      );
    const login = await request(place, "POST", "/api/v1/auth/universal-auth/login", {
      body: { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
    });
    const token = login.body.accessToken;
    if (login.status !== 200 || typeof token !== "string")
      throw new SignInFailed(`${where}: sign-in failed: ${problem(login)}`, { kind: "other" });
    const details = await request(place, "GET", "/api/v1/identities/details", { token });
    const identity = details.body.identityDetails;
    const organization =
      isRecord(identity) && isRecord(identity.organization) ? identity.organization.slug : null;
    if (details.status !== 200 || typeof organization !== "string")
      throw new SignInFailed(
        `${where}: sign-in failed: couldn't read the machine identity's organization: ${problem(details)}`,
        { kind: "other" },
      );
    if (organization !== place.organization)
      throw new SignInFailed(
        `${where}: sign-in failed: the machine identity belongs to the organization ${organization}, but keypin.toml pins ${place.organization}`,
        { kind: "wrong-account", pinned: place.organization, actual: organization },
      );
    return { token, projects: new Map() };
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
    value: boolean,
    imports = true,
  ): Promise<{ secret: Json; project: string } | null> {
    const current = await session(ref);
    const project = await projectId(ref, current, ref.project);
    const found = await request(ref, "GET", `/api/v4/secrets/${encodeURIComponent(ref.name)}`, {
      token: current.token,
      query: {
        projectId: project,
        environment: ref.environment,
        secretPath: ref.path,
        viewSecretValue: String(value),
        expandSecretReferences: "true",
        includeImports: String(imports),
      },
    });
    if (found.status === 404) return null;
    if (found.status !== 200 || !isRecord(found.body.secret))
      throw new Error(`${describeRef(ref)}: ${problem(found)}`);
    return { secret: found.body.secret, project };
  }

  async function existing(ref: InfisicalRef, value: boolean) {
    const found = await secretOf(ref, value);
    if (!found) throw new Error(`${describeRef(ref)}: no such secret`);
    return found;
  }

  async function valueOf(ref: InfisicalRef) {
    const { secret, project } = await existing(ref, true);
    if (secret.secretValueHidden === true || typeof secret.secretValue !== "string")
      throw new Error(
        `${describeRef(ref)}: the machine identity can see this secret but not its value`,
      );
    return { secret: new Secret(secret.secretValue), ids: idsOf(secret, project) };
  }

  return {
    capabilities: { read: true, write: true, list: true, metadata: true },

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
      if (rotated !== undefined && !isDay(rotated))
        throw new Error(
          `${describeRef(ref)}: rotated must be a real day as YYYY-MM-DD, got "${rotated}"`,
        );
      const found = await secretOf(ref, false, false);
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

    async metadata(given) {
      const ref = own(given);
      const { secret } = await existing(ref, false);
      const rotated = metadataOf(secret).find((entry) => entry.key === ROTATED)?.value ?? "";
      if (rotated === "") return { rotated: null };
      if (!isDay(rotated))
        throw new Error(
          `${describeRef(ref)}: the metadata "${ROTATED}" isn't a YYYY-MM-DD date: "${rotated}"`,
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

function withRotated(metadata: Metadata[], rotated: string | undefined): Metadata[] {
  if (rotated === undefined) return metadata;
  return [
    ...metadata.filter((entry) => entry.key !== ROTATED),
    { key: ROTATED, value: rotated, isEncrypted: true },
  ];
}

function problem(response: { status: number; body: Json }): string {
  const message = typeof response.body.message === "string" ? `: ${response.body.message}` : "";
  return `Infisical returned HTTP ${response.status}${message}`;
}

function parseObject(text: string): Json {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
