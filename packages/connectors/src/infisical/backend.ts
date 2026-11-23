import {
  type Fetch,
  HeldForApproval,
  hideSecrets,
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
  ANOTHER_WAY,
  CONFIRMED_URL,
  type Credentials,
  IDENTITY_ID,
  NO_CREDENTIALS,
} from "./credentials";
import { metadataOf, ROTATED, withRotated } from "./metadata";
import {
  account,
  decode,
  decodeScope,
  describe as describeRef,
  type InfisicalPlace as Place,
  type InfisicalRef,
  type InfisicalScope as Scope,
} from "./reference";
import { type Json, problem } from "./response";
import { fromElsewhere, importSource, referencedBy } from "./secret-sources";

const CLOUD = ["https://app.infisical.com", "https://us.infisical.com", "https://eu.infisical.com"];
const LONGEST_TTL_SECONDS = 3600;
const REVOKE_WAIT_MS = 5000;

export interface InfisicalOptions {
  sleep?: (ms: number) => Promise<void>;
  idToken?: IdToken;
  warn?: (text: string) => void;
}

interface Session {
  place: Place;
  token: string;
  minted: boolean;
  projects: Map<string, Promise<string>>;
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      body.message = hideSecrets(body.message, [
        options.token,
        options.body?.jwt,
        options.body?.clientSecret,
        options.body?.secretValue,
      ]);
    if (response.status === 404 && body.error === "Not Found")
      throw fail(
        options.always
          ? `the server has no ${method} ${path}; check that the host in your infisical:// provider in secretspec.toml is the Infisical server`
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
    if ("variable" in credentials) await checkToken(place, token, credentials.variable);
    return { place, token, minted, projects: new Map() };
  }

  async function checkToken(place: Place, token: string, variable: string) {
    const where = account(place);
    const details = await request(place, "GET", "/api/v1/identities/details", {
      token,
      signIn: true,
    });
    if (details.status === 401 || details.status === 403)
      throw new SignInFailed(
        details.status === 401
          ? `${where}: sign-in failed: Infisical refused the access token in ${variable} (HTTP 401); it may have expired, so get a new one`
          : `${where}: sign-in failed: the access token in ${variable} isn't a machine identity's; use a machine identity's access token`,
        { kind: "other" },
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
        `keypin sends GitHub's OIDC token only to Infisical Cloud, and your infisical:// provider in secretspec.toml names ${place.url}; if that server is yours, set ${CONFIRMED_URL}=${place.url} in the job`,
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
        `${account(place)}: couldn't revoke keypin's access token (${hideSecrets(why, [token])}); it lasts until its TTL runs out`,
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

function idsOf(secret: Json, project: string) {
  return { vault: project, item: String(secret.id) };
}

function originOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}
