import {
  type Fetch,
  isRecord,
  type KeyRef,
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
export const NO_CREDENTIALS = `set ${TOKEN_VARIABLE} to a Doppler service token, service account token or personal token`;
const API = "https://api.doppler.com";
const PAGE = 20;

type Json = Record<string, unknown>;

const TOKEN_KINDS: readonly [string, string][] = [
  ["dp.st.", "service token"],
  ["dp.sa.", "service account token"],
  ["dp.said.", "service account identity token"],
  ["dp.pt.", "personal token"],
  ["dp.ct.", "CLI token"],
];

export function tokenFrom(env: Readonly<Record<string, string | undefined>>): string | null {
  return env[TOKEN_VARIABLE]?.trim() || null;
}

export function tokenKind(token: string): string {
  return TOKEN_KINDS.find(([prefix]) => token.startsWith(prefix))?.[1] ?? "token";
}

const isServiceToken = (token: string) => token.startsWith("dp.st.");

export function dopplerBackend(
  token: string | null,
  fetch: Fetch = globalThis.fetch,
): VaultBackend {
  const sessions = new Map<string, Promise<void>>();
  const kind = token === null ? "token" : tokenKind(token);

  async function request(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: Json } = {},
  ): Promise<{ status: number; body: Json }> {
    const query = options.query ? `?${new URLSearchParams(options.query)}` : "";
    const response = await fetch(`${API}${path}${query}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token ?? ""}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }

  async function signIn(place: Place): Promise<void> {
    const where = account(place);
    if (token === null)
      throw new SignInFailed(`${where}: sign-in failed: ${NO_CREDENTIALS}`, {
        kind: "no-credentials",
      });
    const me = await request("GET", "/v3/me");
    if (me.status === 401)
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
        `${where}: sign-in failed: the ${kind} in ${TOKEN_VARIABLE} belongs to the workplace ${name}, but keypin.toml pins ${place.workplace}`,
        { kind: "wrong-account", pinned: place.workplace, actual: slug },
      );
    }
  }

  function session(place: Place): Promise<void> {
    let pending = sessions.get(place.workplace);
    if (!pending) {
      pending = signIn(place);
      sessions.set(place.workplace, pending);
    }
    return pending;
  }

  function refused(scope: Scope, found: { status: number; body: Json }): string {
    const scoped =
      found.status === 403 && token !== null && isServiceToken(token)
        ? `; a service token reads only the config it was made for, so use one made for ${scope.project}/${scope.config}, or a service account token`
        : "";
    return `${problem(found)}${scoped}`;
  }

  async function secretOf(ref: DopplerRef): Promise<{ raw: unknown; computed: unknown }> {
    await session(ref);
    const found = await request("GET", "/v3/configs/config/secret", {
      query: { project: ref.project, config: ref.config, name: ref.name },
    });
    const value = isRecord(found.body.value) ? found.body.value : null;
    if (found.status !== 200 || !value)
      throw new Error(`${describeRef(ref)}: ${refused(ref, found)}`);
    return { raw: value.raw, computed: value.computed };
  }

  async function names(scope: Scope): Promise<string[]> {
    await session(scope);
    const found = await request("GET", "/v3/configs/config/secrets/names", {
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
      const found = await request("GET", "/v3/configs/config/secrets/names", {
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
      found.status === 403 && token !== null && isServiceToken(token)
        ? "; a service token reads only the config it was made for, so use a service account token or personal token that can read it"
        : "";
    return `${describeRef(ref)}: keypin can't read ${what}, so it can't tell whether the secret is inherited from another config: ${problem(found)}${scoped}`;
  }

  async function parentsOf(ref: DopplerRef, fail: (message: string) => Error): Promise<Scope[]> {
    const found = await request("GET", "/v3/configs/config", {
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
      const found = await request("GET", "/v3/configs", {
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
      const written = await request("POST", "/v3/configs/config/secrets", {
        body: { project: ref.project, config: ref.config, secrets: { [ref.name]: value.reveal() } },
      });
      if (written.status >= 400 && written.status < 500) {
        const readOnly =
          written.status === 403
            ? `; keypin needs a ${kind} with write access to ${ref.project}/${ref.config}${token !== null && isServiceToken(token) ? ", so make a service token with read/write access" : ""}`
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

function problem(response: { status: number; body: Json }): string {
  const { messages } = response.body;
  const said = Array.isArray(messages)
    ? messages.filter((message) => typeof message === "string").join("; ")
    : "";
  return `Doppler returned HTTP ${response.status}${said ? `: ${said}` : ""}`;
}
