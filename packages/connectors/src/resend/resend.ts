import {
  type Fetch,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  isRecord,
  NothingChanged,
  parseObject,
  Secret,
} from "@keypin/core";

const API = "https://api.resend.com";
const NAME_LIMIT = 50;

const fitName = (name: string) =>
  name.length <= NAME_LIMIT ? name : `…${name.slice(name.length - NAME_LIMIT + 1)}`;
const DASHBOARD = "https://resend.com/api-keys";

export interface ResendIssuerOptions {
  admin: () => Promise<Secret>;
  permission: "full_access" | "sending_access";
  domainId?: string;
  fetch?: Fetch;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export class ResendIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #permission: ResendIssuerOptions["permission"];
  readonly #domainId: string | undefined;
  readonly #fetch: Fetch;
  #key: Promise<Secret> | undefined;
  #passed = false;
  #listed = new Set<string>();

  constructor(options: ResendIssuerOptions) {
    this.#admin = options.admin;
    this.#permission = options.permission;
    this.#domainId = options.domainId;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return "Resend";
  }

  dashboard(): string {
    return DASHBOARD;
  }

  async checkAccount(currentId: string | null): Promise<IssuerCheck> {
    this.#passed = false;
    const list = await this.#request("GET", "/api-keys");
    if (list.status !== 200) return refused(list);
    const ids = keysOf(list).map((key) => key.id);
    const facts = `the admin key lists ${ids.length} API key${ids.length === 1 ? "" : "s"}`;
    if (currentId !== null && !ids.includes(currentId)) {
      return {
        ok: false,
        facts,
        reason: `Resend doesn't list key ${currentId}, the one keypin issued last time: the admin key belongs to another team, or that key was deleted`,
        fix: `use an admin key from the team at ${DASHBOARD} that has key ${currentId}`,
      };
    }
    this.#passed = true;
    this.#listed = new Set(ids);
    return { ok: true, facts: currentId === null ? facts : `${facts}, with key ${currentId}` };
  }

  async create(name: string): Promise<IssuedKey> {
    if (!this.#passed)
      throw new NothingChanged("refusing to create a Resend key: checkAccount hasn't passed");
    const body = {
      name: fitName(name),
      permission: this.#permission,
      ...(this.#domainId === undefined ? {} : { domain_id: this.#domainId }),
    };
    const created = await this.#request("POST", "/api-keys", body);
    if (created.status !== 200 && created.status !== 201)
      throw failure("POST", "/api-keys", created, created.status < 500 ? NothingChanged : Error);
    const { id, token } = created.body;
    if (typeof id !== "string" || typeof token !== "string" || !token)
      throw new Error("Resend's POST /api-keys response has no id and token");
    return { id, secret: new Secret(token) };
  }

  async find(name: string): Promise<string[]> {
    const list = await this.#request("GET", "/api-keys");
    if (list.status !== 200) throw failure("GET", "/api-keys", list);
    const sent = fitName(name);
    return keysOf(list).flatMap((key) =>
      key.name === sent && !this.#listed.has(key.id) ? [key.id] : [],
    );
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#passed)
      throw new Error("refusing to revoke a Resend key: checkAccount hasn't passed");
    const path = `/api-keys/${encodeURIComponent(id)}`;
    const deleted = await this.#request("DELETE", path);
    if (deleted.status === 404) return "already gone";
    if (deleted.status !== 200) throw failure("DELETE", "/api-keys/<id>", deleted);
    return "revoked";
  }

  async #request(method: string, path: string, body?: unknown): Promise<Reply> {
    this.#key ??= this.#admin();
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${(await this.#key).reveal()}`,
        "User-Agent": "keypin",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

function refused(reply: Reply): IssuerCheck {
  const kind = errorName(reply);
  const facts = `Resend answered HTTP ${reply.status}${kind ? ` ${kind}` : ""}`;
  if (kind === "restricted_api_key")
    return {
      ok: false,
      facts,
      reason: "the admin key can only send emails, so it can't create or delete keys",
      fix: `put a key with full access in the admin item; create one at ${DASHBOARD}`,
    };
  if (reply.status === 400 || reply.status === 401 || reply.status === 403)
    return {
      ok: false,
      facts,
      reason:
        "Resend doesn't accept the admin key: it was deleted, or the item holds another value",
      fix: `put a key with full access in the admin item; create one at ${DASHBOARD}`,
    };
  throw failure("GET", "/api-keys", reply);
}

function keysOf(reply: Reply): { id: string; name: unknown }[] {
  const keys = Array.isArray(reply.body.data) ? reply.body.data : [];
  return keys.flatMap((key: unknown) =>
    isRecord(key) && typeof key.id === "string" ? [{ id: key.id, name: key.name }] : [],
  );
}

function failure(
  method: string,
  path: string,
  reply: Reply,
  type: new (message: string) => Error = Error,
): Error {
  const kind = errorName(reply);
  return new type(
    `Resend ${method} ${path} returned HTTP ${reply.status}${kind ? ` ${kind}` : ""}`,
  );
}

function errorName(reply: Reply): string | null {
  const name = reply.body.name;
  return typeof name === "string" && /^[a-z_]+$/.test(name) ? name : null;
}
