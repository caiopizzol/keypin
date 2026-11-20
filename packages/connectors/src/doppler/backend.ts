import {
  type Fetch,
  type IdToken,
  isRecord,
  type KeyRef,
  messageOf,
  NoIdToken,
  parseObject,
  Secret,
  SignInFailed,
  type VaultBackend,
  type VaultItem,
  type VaultScope,
  WriteRefused,
} from "@keypin/core";
import {
  account,
  decode,
  decodeScope,
  describe as describeRef,
  type DopplerPin as Place,
  type DopplerRef,
  type DopplerScope as Scope,
  format,
} from "./reference";

export const TOKEN_VARIABLE = "DOPPLER_TOKEN";
export const IDENTITY_ID = "KEYPIN_DOPPLER_IDENTITY_ID";
export const AUDIENCE = "KEYPIN_DOPPLER_AUDIENCE";
export const NO_CREDENTIALS = `set ${TOKEN_VARIABLE} to a Doppler service token, service account token or personal token`;
const ANOTHER_WAY = `or unset ${IDENTITY_ID} to sign in another way`;
export const NO_JOB_TOKEN = `give the GitHub Actions job permissions: id-token: write, ${ANOTHER_WAY}`;
const API = "https://api.doppler.com";
const PAGE = 20;
const IDENTITY_TOKEN = "service account identity token";
const LONGEST_TTL_MS = 3600_000;
const REVOKE_WAIT_MS = 5000;

type Json = Record<string, unknown>;

export type Credentials =
  | { token: string }
  | { identityId: string; audience: string | null }
  | { problem: string };

export interface DopplerOptions {
  idToken?: IdToken;
  warn?: (text: string) => void;
}

interface Session {
  place: Place;
  token: string;
  minted: boolean;
}

const TOKEN_KINDS: readonly [string, string][] = [
  ["dp.st.", "service token"],
  ["dp.sa.", "service account token"],
  ["dp.said.", IDENTITY_TOKEN],
  ["dp.pt.", "personal token"],
  ["dp.ct.", "CLI token"],
];

export function credentialsFrom(
  env: Readonly<Record<string, string | undefined>>,
): Credentials | null {
  const identityId = env[IDENTITY_ID]?.trim() ?? "";
  const token = env[TOKEN_VARIABLE]?.trim() ?? "";
  if (identityId && token)
    return {
      problem: `both ${IDENTITY_ID} and ${TOKEN_VARIABLE} are set; unset ${TOKEN_VARIABLE} to sign in with GitHub Actions OIDC, or ${IDENTITY_ID} to sign in with it`,
    };
  if (identityId) return { identityId, audience: env[AUDIENCE]?.trim() || null };
  return token ? { token } : null;
}

export function tokenKind(token: string): string {
  return TOKEN_KINDS.find(([prefix]) => token.startsWith(prefix))?.[1] ?? "token";
}

const isServiceToken = (token: string) => token.startsWith("dp.st.");

export function dopplerBackend(
  credentials: Credentials | null,
  fetch: Fetch = globalThis.fetch,
  options: DopplerOptions = {},
): VaultBackend {
  const warn = options.warn ?? (() => {});
  const sessions = new Map<string, Promise<Session>>();
  const strict = credentials !== null && "identityId" in credentials;
  const stored = credentials !== null && "token" in credentials ? credentials.token : null;
  const kind = strict ? IDENTITY_TOKEN : stored === null ? "token" : tokenKind(stored);
  const serviceToken = stored !== null && isServiceToken(stored);
  const held = strict ? `for the identity in ${IDENTITY_ID}` : `in ${TOKEN_VARIABLE}`;
  const secrets = stored === null ? [] : [stored];

  function hidden(text: string): string {
    return secrets.reduce((shown, secret) => shown.replaceAll(secret, "[hidden]"), text);
  }

  function problem(response: { status: number; body: Json }): string {
    return hidden(said(response));
  }

  async function request(
    method: string,
    path: string,
    options: { token?: string; query?: Record<string, string>; body?: Json } = {},
  ): Promise<{ status: number; body: Json }> {
    const query = options.query ? `?${new URLSearchParams(options.query)}` : "";
    const response = await fetch(`${API}${path}${query}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(strict ? { redirect: "error" as const } : {}),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }

  async function signedIn(
    place: Place,
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: Json } = {},
  ): Promise<{ status: number; body: Json }> {
    const { token } = await session(place);
    return request(method, path, { ...options, token });
  }

  async function signIn(place: Place): Promise<Session> {
    const where = account(place);
    if (!credentials)
      throw new SignInFailed(`${where}: sign-in failed: ${NO_CREDENTIALS}`, {
        kind: "no-credentials",
      });
    if ("problem" in credentials)
      throw new SignInFailed(`${where}: sign-in failed: ${credentials.problem}`, { kind: "other" });
    if ("token" in credentials) {
      await checkWorkplace(place, credentials.token);
      return { place, token: credentials.token, minted: false };
    }
    const token = await oidcToken(place, credentials);
    try {
      await checkWorkplace(place, token);
    } catch (error) {
      await revoke(place, token);
      throw error;
    }
    return { place, token, minted: true };
  }

  async function checkWorkplace(place: Place, token: string): Promise<void> {
    const where = account(place);
    const me = await request("GET", "/v3/me", { token });
    if (me.status === 401 && !strict)
      throw new SignInFailed(
        `${where}: sign-in failed: Doppler refused the ${kind} in ${TOKEN_VARIABLE} (HTTP 401); it may be revoked or expired, so make a new one`,
        { kind: "other" },
      );
    const workplace = isRecord(me.body.workplace) ? me.body.workplace : {};
    const slug = workplace.slug;
    if (me.status !== 200 || typeof slug !== "string")
      throw new SignInFailed(
        `${where}: sign-in failed: couldn't read the ${kind}'s workplace (${problem(me)})`,
        { kind: "other" },
      );
    if (slug !== place.workplace) {
      const name = typeof workplace.name === "string" ? `${workplace.name} (${slug})` : slug;
      throw new SignInFailed(
        `${where}: sign-in failed: the ${kind} ${held} belongs to the workplace ${name}, but keypin.toml pins ${place.workplace}`,
        { kind: "wrong-account", pinned: place.workplace, actual: slug },
      );
    }
  }

  async function oidcToken(
    place: Place,
    given: { identityId: string; audience: string | null },
  ): Promise<string> {
    const failed = (why: string, kind: "no-credentials" | "other" = "other") =>
      new SignInFailed(`${account(place)}: sign-in failed: ${why}`, { kind });
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
    secrets.push(jwt);
    const login = await request("POST", "/v3/auth/oidc", {
      body: { identity: given.identityId, token: jwt },
    });
    const token = login.body.token;
    if (typeof token === "string" && token) secrets.push(token);
    if (login.status !== 200 || typeof token !== "string" || !token) {
      const audience = given.audience ?? "GitHub's default audience, https://github.com/<owner>";
      throw failed(
        `Doppler refused GitHub's OIDC token for the identity ${given.identityId} (${problem(login)}); keypin asked GitHub for a token for ${audience}, so check that the identity's aud claim lists it and that its sub claim matches this job`,
      );
    }
    const expires =
      typeof login.body.expires_at === "string" ? Date.parse(login.body.expires_at) : Number.NaN;
    if (expires - Date.now() > LONGEST_TTL_MS)
      warn(
        `the Doppler identity ${given.identityId} gives out tokens that last more than an hour; set its token TTL to a few minutes`,
      );
    return token;
  }

  async function revoke(place: Place, token: string): Promise<void> {
    let why: string | null;
    try {
      const response = await fetch(`${API}/v3/auth/revoke`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
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
        `${account(place)}: couldn't revoke keypin's ${IDENTITY_TOKEN} (${hidden(why)}); it lasts until its TTL runs out`,
      );
  }

  function session(place: Place): Promise<Session> {
    let pending = sessions.get(place.workplace);
    if (!pending) {
      pending = signIn(place);
      sessions.set(place.workplace, pending);
    }
    return pending;
  }

  function refused(scope: Scope, found: { status: number; body: Json }): string {
    const scoped =
      found.status === 403 && serviceToken
        ? `; a service token reads only the config it was made for, so use one made for ${scope.project}/${scope.config}, or a service account token`
        : "";
    return `${problem(found)}${scoped}`;
  }

  async function secretOf(ref: DopplerRef): Promise<{ raw: unknown; computed: unknown }> {
    const found = await signedIn(ref, "GET", "/v3/configs/config/secret", {
      query: { project: ref.project, config: ref.config, name: ref.name },
    });
    const value = isRecord(found.body.value) ? found.body.value : null;
    if (found.status !== 200 || !value)
      throw new Error(`${describeRef(ref)}: ${refused(ref, found)}`);
    return { raw: value.raw, computed: value.computed };
  }

  async function names(scope: Scope): Promise<string[]> {
    const found = await signedIn(scope, "GET", "/v3/configs/config/secrets/names", {
      query: { project: scope.project, config: scope.config },
    });
    if (found.status !== 200 || !Array.isArray(found.body.names))
      throw new Error(
        `${account(scope)}: couldn't list ${scope.project}/${scope.config}: ${refused(scope, found)}`,
      );
    return found.body.names.filter((name): name is string => typeof name === "string");
  }

  async function existing(ref: DopplerRef) {
    if (!(await names(ref)).includes(ref.name))
      throw new Error(`${describeRef(ref)}: no secret ${ref.name} in ${ref.project}/${ref.config}`);
    return idsOf(ref);
  }

  async function valueOf(ref: DopplerRef) {
    const { computed } = await secretOf(ref);
    if (typeof computed !== "string")
      throw new Error(
        `${describeRef(ref)}: Doppler hides this restricted secret's value from a ${kind}; use a service token or service account token`,
      );
    if (computed === "") throw new Error(`${describeRef(ref)}: the value is empty`);
    return { secret: new Secret(computed), ids: idsOf(ref) };
  }

  async function ownSecret(ref: DopplerRef, fail: (message: string) => Error): Promise<void> {
    const { raw } = await secretOf(ref);
    if (typeof raw !== "string")
      throw fail(
        `${describeRef(ref)}: Doppler hides this restricted secret's value from a ${kind}, so keypin can't tell whether it references another secret; use a service token or service account token`,
      );
    const sources = referencedBy(ref, raw);
    if (sources.length)
      throw fail(
        `${describeRef(ref)}: the secret references ${sources.join(" and ")}, so a new key saved here would leave that secret, and everything that uses it, with the old key; point keypin.toml at ${sourceOf(sources)} instead`,
      );
    const holders: string[] = [];
    for (const parent of await parentsOf(ref, fail)) {
      const found = await signedIn(ref, "GET", "/v3/configs/config/secrets/names", {
        query: { project: parent.project, config: parent.config },
      });
      if (found.status !== 200 || !Array.isArray(found.body.names))
        throw fail(
          unknownSource(
            ref,
            `${parent.project}/${parent.config}, which ${ref.project}/${ref.config} inherits from`,
            found,
          ),
        );
      if (found.body.names.includes(ref.name)) holders.push(format({ ...parent, name: ref.name }));
    }
    if (holders.length)
      throw fail(
        `${describeRef(ref)}: ${ref.project}/${ref.config} inherits ${holders.join(" and ")}, and Doppler doesn't say whether the secret here overrides it, so a new key saved here could leave that secret, and every config that inherits it, with the old key; point keypin.toml at ${sourceOf(holders)} instead`,
      );
  }

  function unknownSource(ref: DopplerRef, what: string, found: { status: number; body: Json }) {
    const scoped =
      found.status === 403 && serviceToken
        ? "; a service token reads only the config it was made for, so use a service account token or personal token that can read it"
        : "";
    return `${describeRef(ref)}: keypin can't read ${what}, so it can't tell whether the secret is inherited from another config: ${problem(found)}${scoped}`;
  }

  async function parentsOf(ref: DopplerRef, fail: (message: string) => Error): Promise<Scope[]> {
    const found = await signedIn(ref, "GET", "/v3/configs/config", {
      query: { project: ref.project, config: ref.config },
    });
    const config = isRecord(found.body.config) ? found.body.config : {};
    const { root, environment } = config;
    const inherits = config.inherits ?? [];
    if (
      found.status !== 200 ||
      typeof root !== "boolean" ||
      typeof environment !== "string" ||
      !Array.isArray(inherits) ||
      !inherits.every(isConfigName)
    )
      throw fail(unknownSource(ref, `the details of ${ref.project}/${ref.config}`, found));
    const inherited = inherits.map((parent): Scope => ({ ...scopeOf(ref), ...parent }));
    return root ? inherited : [await rootOf(ref, environment, fail), ...inherited];
  }

  async function rootOf(
    ref: DopplerRef,
    environment: string,
    fail: (message: string) => Error,
  ): Promise<Scope> {
    for (let page = 1; ; page++) {
      const found = await signedIn(ref, "GET", "/v3/configs", {
        query: { project: ref.project, environment, page: String(page), per_page: String(PAGE) },
      });
      const configs = Array.isArray(found.body.configs)
        ? found.body.configs.filter(isRecord)
        : null;
      if (found.status !== 200 || !configs)
        throw fail(unknownSource(ref, `the configs of ${ref.project}`, found));
      const root = configs.find((config) => config.root === true);
      if (root && typeof root.name === "string") return { ...scopeOf(ref), config: root.name };
      if (configs.length < PAGE)
        throw fail(
          `${describeRef(ref)}: Doppler lists no root config for ${ref.project}'s ${environment} environment, so keypin can't tell whether the secret is inherited from it`,
        );
    }
  }

  return {
    async read(given) {
      return (await valueOf(own(given))).secret;
    },

    async readItem(given) {
      return valueOf(own(given));
    },

    async itemIds(given) {
      return existing(own(given));
    },

    async write(given, value, options = {}) {
      const ref = own(given);
      if (options.newItem && (await names(ref)).includes(ref.name))
        throw new WriteRefused(
          `${describeRef(ref)}: the secret already exists; keypin doesn't overwrite it`,
        );
      if (!options.newItem) await ownSecret(ref, (message) => new WriteRefused(message));
      const written = await signedIn(ref, "POST", "/v3/configs/config/secrets", {
        body: { project: ref.project, config: ref.config, secrets: { [ref.name]: value.reveal() } },
      });
      if (written.status >= 400 && written.status < 500) {
        const readOnly =
          written.status === 403
            ? `; keypin needs a ${kind} with write access to ${ref.project}/${ref.config}${serviceToken ? ", so make a service token with read/write access" : ""}`
            : "";
        throw new WriteRefused(`${describeRef(ref)}: ${problem(written)}${readOnly}`);
      }
      if (written.status !== 200 || !isRecord(written.body.secrets))
        throw new Error(`${describeRef(ref)}: ${problem(written)}`);
    },

    async checkWrite(given) {
      await ownSecret(own(given), (message) => new Error(message));
    },

    async list(given) {
      const scope = ownScope(given);
      return (await names(scope)).map((name): VaultItem => ({
        id: name,
        title: name,
        tags: [],
        updatedAt: "",
      }));
    },

    async metadata(given) {
      await existing(own(given));
      return { rotated: null };
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
  };
}

function own(ref: KeyRef): DopplerRef {
  const mine = decode(ref);
  if (!mine)
    throw new Error(`keypin's Doppler vault can't read this reference, which is for ${ref.kind}`);
  return mine;
}

function ownScope(scope: VaultScope): Scope {
  const mine = decodeScope(scope);
  if (!mine) throw new Error(`keypin's Doppler vault can't list ${scope.kind} items`);
  return mine;
}

function scopeOf(ref: DopplerRef): Scope {
  return { kind: ref.kind, workplace: ref.workplace, project: ref.project, config: ref.config };
}

function isConfigName(entry: unknown): entry is { project: string; config: string } {
  return isRecord(entry) && typeof entry.project === "string" && typeof entry.config === "string";
}

function sourceOf(sources: string[]): string {
  const [only] = sources;
  return sources.length === 1 && only ? only : "the source secret";
}

function idsOf(ref: DopplerRef) {
  return { vault: `${ref.project}/${ref.config}`, item: ref.name };
}

const REFERENCE = /\$\{([^}]+)\}/g;
const QUOTED = /^(?:(.*)\.)?"([^"]*)"$/;

function referencedBy(ref: DopplerRef, raw: string): string[] {
  return [
    ...new Set([...raw.matchAll(REFERENCE)].map(([, inner = ""]) => referenceTo(ref, inner))),
  ];
}

function referenceTo(ref: DopplerRef, inner: string): string {
  const quoted = QUOTED.exec(inner);
  const parts = quoted ? (quoted[1]?.split(".") ?? []) : inner.split(".");
  const name = quoted ? (quoted[2] ?? "") : (parts.pop() ?? "");
  const config = parts.pop() ?? ref.config;
  const project = parts.pop() ?? ref.project;
  return format({ ...ref, project, config, name });
}

function said(response: { status: number; body: Json }): string {
  const { messages } = response.body;
  const said = Array.isArray(messages)
    ? messages.filter((message) => typeof message === "string").join("; ")
    : "";
  return `Doppler returned HTTP ${response.status}${said ? `: ${said}` : ""}`;
}
