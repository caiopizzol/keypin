import {
  type Fetch,
  fitKeyName,
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

const fitName = (name: string) => fitKeyName(name, NAME_LIMIT);
const DASHBOARD = "https://resend.com/api-keys";
const DOMAINS = "https://resend.com/domains";

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

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#passed = false;
    const list = await this.#request("GET", "/api-keys");
    if (list.status !== 200) return refused(list);
    const ids = keysOf(list).map((key) => key.id);
    let facts = `the admin key lists ${ids.length} API key${ids.length === 1 ? "" : "s"}`;
    if (this.#domainId !== undefined) {
      const domain = await this.#request("GET", `/domains/${encodeURIComponent(this.#domainId)}`);
      if (domain.status === 404 || domain.status === 422)
        return {
          ok: false,
          facts,
          reason: `the admin key's team has no Resend domain ${this.#domainId}`,
          fix: `check domain_id in secretspec.toml against ${DOMAINS}`,
        };
      if (domain.status !== 200) throw failure("GET", "/domains/<domain_id>", domain);
      const name = typeof domain.body.name === "string" ? domain.body.name : this.#domainId;
      facts = `${facts} and domain ${name}`;
    }
    if (currentId !== null && ids.includes(currentId)) {
      this.#passed = true;
      return { ok: true, facts: `${facts}, with key ${currentId}` };
    }
    const vault = await this.#vaultKey(current);
    if (currentId !== null) {
      if (vault.kind === "deleted") {
        this.#passed = true;
        return {
          ok: true,
          facts: `${facts}; Resend doesn't accept the vault's key`,
          gone: `key ${currentId} was deleted at Resend`,
        };
      }
      return {
        ok: false,
        facts,
        reason: `Resend doesn't list key ${currentId}, the one keypin issued last time, but it still knows the vault's key: the admin key belongs to another team`,
        fix: `use an admin key from the team at ${DASHBOARD} that has key ${currentId}`,
      };
    }
    if (vault.kind === "deleted")
      return {
        ok: false,
        facts: `${facts}; Resend doesn't accept the vault's key`,
        reason:
          "keypin didn't issue the vault's key, so it can't tell whether the key was deleted or the vault holds another value",
        fix: `put the key your apps use in the vault, then run this again; if it was deleted, make a new one at ${DASHBOARD}`,
      };
    if (vault.kind === "disabled")
      return {
        ok: false,
        facts,
        reason: `the vault's key ${vault.why}, so keypin can't tell which Resend team it belongs to`,
        fix: `check the key at ${DASHBOARD}; put an active key in the vault, then run this again`,
      };
    if (vault.kind === "sending") {
      this.#passed = true;
      return {
        ok: true,
        facts,
        notes: {
          create:
            "the vault's key can only send emails, so keypin can't check that the admin key is from its team",
        },
      };
    }
    if (!vault.ids.some((id) => ids.includes(id)))
      return {
        ok: false,
        facts,
        reason: "the vault's key and the admin key belong to different Resend teams",
        fix: `use an admin key from the vault key's team; create one at ${DASHBOARD}`,
      };
    this.#passed = true;
    return { ok: true, facts: `${facts}, in the vault key's team` };
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
      throw failure(
        "POST",
        "/api-keys",
        created,
        created.status >= 400 && created.status < 500 ? NothingChanged : Error,
      );
    const { id, token } = created.body;
    if (typeof id !== "string" || typeof token !== "string" || !token)
      throw new Error("Resend's POST /api-keys response has no id and token");
    return { id, secret: new Secret(token) };
  }

  lostCreate(name: string): string {
    return `Resend may have made the key before the reply was lost. Only this run uses the name "${fitName(name)}": delete a key with that name at ${DASHBOARD} before you run this again, or the rerun leaves it live.`;
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

  async #vaultKey(
    current: Secret,
  ): Promise<
    | { kind: "listed"; ids: string[] }
    | { kind: "sending" }
    | { kind: "disabled"; why: string }
    | { kind: "deleted" }
  > {
    const reply = await this.#request("GET", "/api-keys", undefined, current);
    const kind = errorName(reply);
    if (reply.status === 200) return { kind: "listed", ids: keysOf(reply).map((key) => key.id) };
    if (reply.status === 401 && kind === "restricted_api_key") return { kind: "sending" };
    if (reply.status === 403 && kind === "restricted_api_key")
      return { kind: "disabled", why: "isn't active" };
    if (reply.status === 403 && kind === "suspended_api_key")
      return { kind: "disabled", why: "is suspended" };
    if (reply.status === 400 && kind === "validation_error") return { kind: "deleted" };
    throw failure("GET", "/api-keys with the vault's key", reply);
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

function refused(reply: Reply): IssuerCheck {
  const kind = errorName(reply);
  const facts = `Resend answered HTTP ${reply.status}${kind ? ` ${kind}` : ""}`;
  const fix = `put a key with full access in the admin item; create one at ${DASHBOARD}`;
  if (reply.status === 401 && kind === "restricted_api_key")
    return {
      ok: false,
      facts,
      reason: "the admin key can only send emails, so it can't create or delete keys",
      fix,
    };
  if (reply.status === 403 && kind === "restricted_api_key")
    return { ok: false, facts, reason: "the admin key isn't active at Resend", fix };
  if (reply.status === 403 && kind === "suspended_api_key")
    return { ok: false, facts, reason: "Resend suspended the admin key", fix };
  if (reply.status === 400 || reply.status === 401 || reply.status === 403)
    return {
      ok: false,
      facts,
      reason:
        "Resend doesn't accept the admin key: it was deleted, or the item holds another value",
      fix,
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
