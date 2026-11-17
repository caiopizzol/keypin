import {
  type Fetch,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  isRecord,
  NothingChanged,
  objectField,
  parseObject,
  Secret,
} from "@keypin/core";

const API = "https://api.openai.com/v1";
const DASHBOARD = "https://platform.openai.com/settings/organization/api-keys";
const ADMIN_KEYS = "https://platform.openai.com/settings/organization/admin-keys";
const SETTINGS = "https://platform.openai.com/settings";
const PAGE = 100;
const PAGES = 100;
const LONGEST_LIFETIME = 31_536_000;

export interface OpenAIIssuerOptions {
  admin: () => Promise<Secret>;
  projectId: string;
  scopes: readonly string[];
  fetch?: Fetch;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

interface ProjectKey {
  id: string;
  name: string;
  redacted: string;
  owner: { type: string; id: string; name: string };
  lifetime: number | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export class OpenAIIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #projectId: string;
  readonly #scopes: readonly string[];
  readonly #fetch: Fetch;
  #key: Promise<Secret> | undefined;
  #passed = false;
  #project = "";
  #serviceAccount = "";
  #lifetime: number | null = null;
  readonly #names = new Map<string, string>();

  constructor(options: OpenAIIssuerOptions) {
    this.#admin = options.admin;
    this.#projectId = options.projectId;
    this.#scopes = options.scopes;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return "OpenAI";
  }

  dashboard(): string {
    return DASHBOARD;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#passed = false;
    const project = await this.#request("GET", this.#projectPath());
    if (project.status !== 200) return this.#refused(project);
    const name = project.body.name;
    this.#project = typeof name === "string" && name ? name : this.#projectId;
    const keys = await this.#keys();
    if (!Array.isArray(keys)) return this.#refused(keys);
    const facts = `project ${this.#project} lists ${plural(keys.length, "API key")}`;

    if (currentId !== null) {
      const issued = parseId(currentId);
      if (!issued)
        return {
          ok: false,
          facts,
          reason: `${currentId}, the key keypin issued last time, isn't an OpenAI key ID`,
          fix: `delete that key at ${DASHBOARD} if it's still live, then run this again`,
        };
      const listed = keys.find((key) => key.id === issued.key);
      if (listed) return this.#pass(listed, `${facts}, with key ${listed.id}`);
      if (await this.#refusesVaultKey(current)) {
        this.#serviceAccount = issued.serviceAccount;
        this.#lifetime = null;
        this.#passed = true;
        return {
          ok: true,
          facts: `${facts}; OpenAI doesn't accept the vault's key`,
          gone: `key ${issued.key} was deleted at OpenAI`,
        };
      }
      return {
        ok: false,
        facts,
        reason: `project ${this.#project} doesn't list key ${issued.key}, the one keypin issued last time, but OpenAI still accepts the vault's key`,
        fix: `check project_id in keypin.toml, and that the admin key is from the organization that has the key at ${DASHBOARD}`,
      };
    }

    const matches = keys.filter((key) => sameKey(key.redacted, current));
    const [match, ...more] = matches;
    if (!match)
      return {
        ok: false,
        facts,
        reason: `no key in project ${this.#project} matches the vault's key: it was deleted, it's from another project, or the item holds another value`,
        fix: `check project_id in keypin.toml against ${SETTINGS}, and put the key your apps use in the vault`,
      };
    if (more.length)
      return {
        ok: false,
        facts,
        reason: `${matches.length} keys in project ${this.#project} start and end like the vault's key (${matches.map((key) => key.id).join(", ")}), so keypin can't tell which one it is`,
        fix: `delete the keys nothing uses at ${DASHBOARD}, then run this again`,
      };
    const passed = this.#pass(match, `${facts}, with the vault's key ${match.id}`);
    return passed.ok ? { ...passed, currentId: idOf(match.owner.id, match.id) } : passed;
  }

  async create(name: string): Promise<IssuedKey> {
    if (!this.#passed)
      throw new NothingChanged("refusing to create an OpenAI key: checkAccount hasn't passed");
    const path = `${this.#projectPath()}/service_accounts/${encodeURIComponent(this.#serviceAccount)}/api_keys`;
    const body = {
      name,
      ...(this.#scopes.length ? { scopes: this.#scopes } : {}),
      ...(this.#lifetime === null ? {} : { expires_in_seconds: this.#lifetime }),
    };
    const created = await this.#request("POST", path, body);
    const shown = "/organization/projects/<project_id>/service_accounts/<id>/api_keys";
    if (created.status === 401 || created.status === 403)
      throw new NothingChanged(
        `the admin key can't create keys in project ${this.#project}: give it write access to projects at ${ADMIN_KEYS}`,
      );
    if (created.status !== 200 && created.status !== 201)
      throw failure(
        "POST",
        shown,
        created,
        created.status >= 400 && created.status < 500 ? NothingChanged : Error,
      );
    const { id, value } = created.body;
    if (typeof id !== "string" || !id || typeof value !== "string" || !value)
      throw new Error(`OpenAI's POST ${shown} response has no id and value`);
    return { id: idOf(this.#serviceAccount, id), secret: new Secret(value) };
  }

  label(id: string): string {
    const parsed = parseId(id);
    const name = parsed && this.#names.get(parsed.serviceAccount);
    return parsed && name ? `${parsed.key} of service account ${name}` : id;
  }

  lostCreate(name: string): string {
    return `OpenAI may have made the key before the reply was lost. Only this run uses the name "${name}": delete a key with that name in project ${this.#project} at ${DASHBOARD} before you run this again, or the rerun leaves it live.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#passed)
      throw new Error("refusing to revoke an OpenAI key: checkAccount hasn't passed");
    const key = parseId(id)?.key ?? id;
    const deleted = await this.#request(
      "DELETE",
      `${this.#projectPath()}/api_keys/${encodeURIComponent(key)}`,
    );
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403)
      throw new Error(
        `the admin key can't delete keys in project ${this.#project}: give it write access to projects at ${ADMIN_KEYS}, or delete key ${key} at ${DASHBOARD}`,
      );
    if (deleted.status !== 200)
      throw failure("DELETE", "/organization/projects/<project_id>/api_keys/<id>", deleted);
    return "revoked";
  }

  #pass(key: ProjectKey, facts: string): IssuerCheck {
    if (key.owner.type !== "service_account" || !key.owner.id)
      return {
        ok: false,
        facts,
        reason: `key ${key.id} belongs to a user, and OpenAI's Admin API makes keys only for service accounts`,
        fix: `at ${DASHBOARD}, make a key in project ${this.#project} owned by a service account, put it in the vault and give it to your apps, then run this again`,
      };
    this.#serviceAccount = key.owner.id;
    this.#lifetime = key.lifetime;
    this.#passed = true;
    const scopes = this.#scopes.length ? `scopes ${this.#scopes.join(", ")}` : "all permissions";
    const expires =
      key.lifetime === null
        ? ""
        : `, expiring in ${plural(Math.ceil(key.lifetime / 86_400), "day")}`;
    return {
      ok: true,
      facts: `${facts} of service account ${key.owner.name}`,
      notes: { create: `for service account ${key.owner.name}, with ${scopes}${expires}` },
    };
  }

  #refused(reply: Reply): IssuerCheck {
    const code = errorCode(reply);
    const facts = `OpenAI answered HTTP ${reply.status}${code ? ` ${code}` : ""}`;
    const fix = `put an Admin key with write access to projects in the admin item; create one at ${ADMIN_KEYS}`;
    if (reply.status === 401)
      return {
        ok: false,
        facts,
        reason:
          "OpenAI doesn't accept the admin key: it isn't an Admin key, it was deleted, or the item holds another value",
        fix,
      };
    if (reply.status === 403)
      return {
        ok: false,
        facts,
        reason: `the admin key can't manage the keys of project ${this.#projectId}`,
        fix,
      };
    if (reply.status === 404)
      return {
        ok: false,
        facts,
        reason: `the admin key's organization has no project ${this.#projectId}`,
        fix: `check project_id in keypin.toml against ${SETTINGS}`,
      };
    throw failure("GET", "/organization/projects/<project_id>", reply);
  }

  async #keys(): Promise<ProjectKey[] | Reply> {
    const keys: ProjectKey[] = [];
    let after: string | null = null;
    for (let page = 0; page < PAGES; page++) {
      const cursor: string = after === null ? "" : `&after=${encodeURIComponent(after)}`;
      const reply = await this.#request(
        "GET",
        `${this.#projectPath()}/api_keys?limit=${PAGE}&owner_project_access=any${cursor}`,
      );
      if (reply.status === 401 || reply.status === 403) return reply;
      if (reply.status !== 200)
        throw failure("GET", "/organization/projects/<project_id>/api_keys", reply);
      const data = Array.isArray(reply.body.data) ? reply.body.data : [];
      for (const key of data.flatMap(projectKey)) {
        keys.push(key);
        this.#names.set(key.owner.id, key.owner.name);
      }
      const last = reply.body.last_id ?? keys.at(-1)?.id;
      if (reply.body.has_more !== true || typeof last !== "string" || last === after) return keys;
      after = last;
    }
    throw new Error(`OpenAI project ${this.#projectId} lists more than ${PAGE * PAGES} API keys`);
  }

  async #refusesVaultKey(current: Secret): Promise<boolean> {
    const reply = await this.#request("GET", "/models", undefined, current);
    if (reply.status === 401 && errorCode(reply) === "invalid_api_key") return true;
    if (reply.status === 200 || reply.status === 403 || reply.status === 429) return false;
    throw failure("GET", "/models with the vault's key", reply);
  }

  #projectPath(): string {
    return `/organization/projects/${encodeURIComponent(this.#projectId)}`;
  }

  async #request(method: string, path: string, body?: unknown, as?: Secret): Promise<Reply> {
    this.#key ??= this.#admin();
    const key = as ?? (await this.#key);
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key.reveal()}`,
        "User-Agent": "keypin",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

const idOf = (serviceAccount: string, key: string) => `${serviceAccount}/${key}`;

function parseId(id: string): { serviceAccount: string; key: string } | null {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1) return null;
  return { serviceAccount: id.slice(0, at), key: id.slice(at + 1) };
}

function projectKey(item: unknown): ProjectKey[] {
  if (!isRecord(item) || typeof item.id !== "string") return [];
  const owner = objectField(item, "owner");
  const type = typeof owner.type === "string" ? owner.type : "";
  const who = objectField(owner, type);
  const created = item.created_at;
  const expires = item.expires_at;
  const lifetime =
    typeof created === "number" && typeof expires === "number" && expires > created
      ? Math.min(expires - created, LONGEST_LIFETIME)
      : null;
  const id = typeof who.id === "string" ? who.id : "";
  return [
    {
      id: item.id,
      name: typeof item.name === "string" ? item.name : item.id,
      redacted: typeof item.redacted_value === "string" ? item.redacted_value : "",
      owner: { type, id, name: typeof who.name === "string" && who.name ? who.name : id },
      lifetime,
    },
  ];
}

function sameKey(redacted: string, current: Secret): boolean {
  const shown = /^(.+?)(?:\*+|\.{3})([^*.]{3,})$/.exec(redacted);
  if (!shown) return false;
  const [, start = "", end = ""] = shown;
  const value = current.reveal();
  return value.length > start.length + end.length && value.startsWith(start) && value.endsWith(end);
}

function failure(
  method: string,
  path: string,
  reply: Reply,
  type: new (message: string) => Error = Error,
): Error {
  const code = errorCode(reply);
  return new type(
    `OpenAI ${method} ${path} returned HTTP ${reply.status}${code ? ` ${code}` : ""}`,
  );
}

function errorCode(reply: Reply): string | null {
  const error = objectField(reply.body, "error");
  const code = typeof error.code === "string" ? error.code : error.type;
  return typeof code === "string" && /^[a-z_]+$/.test(code) ? code : null;
}
