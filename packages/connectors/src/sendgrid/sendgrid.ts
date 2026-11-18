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

const HOSTS = { global: "https://api.sendgrid.com", eu: "https://api.eu.sendgrid.com" } as const;
const DASHBOARD = "https://app.sendgrid.com/settings/api_keys";
const SUBUSERS = "https://app.sendgrid.com/settings/subusers";
const MANAGE = ["api_keys.create", "api_keys.read", "api_keys.delete"];
const ADMIN_FIX = `put a key with Full Access, or with API Keys Full Access, in the admin item; create one at ${DASHBOARD}`;

export interface SendGridIssuerOptions {
  admin: () => Promise<Secret>;
  subuser?: string;
  region?: "eu";
  fetch?: Fetch;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export class SendGridIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #subuser: string | undefined;
  readonly #api: string;
  readonly #fetch: Fetch;
  #key: Promise<Secret> | undefined;
  #scopes: string[] | null = null;
  readonly #names = new Map<string, string>();

  constructor(options: SendGridIssuerOptions) {
    this.#admin = options.admin;
    this.#subuser = options.subuser;
    this.#api = HOSTS[options.region ?? "global"];
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return "SendGrid";
  }

  dashboard(): string {
    return DASHBOARD;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#scopes = null;
    const admin = await this.#adminKey();
    const adminId = idIn(admin);
    if (admin.equals(current) || (adminId !== null && adminId === (currentId ?? idIn(current))))
      return {
        ok: false,
        facts: "the admin item and the key's item hold the same key",
        reason: "the vault's key is the admin key keypin signs in with",
        fix: "put the key your apps use in the vault, and a key that manages API keys in its own admin item",
      };
    const own = await this.#request("GET", "/v3/scopes", undefined, false);
    if (own.status !== 200) return this.#refused(own);
    const granted = scopesOf(own.body);
    const lacking = MANAGE.filter((scope) => !granted.includes(scope));
    if (lacking.length)
      return {
        ok: false,
        facts: `the admin key has ${plural(granted.length, "scope")}, without ${lacking.join(", ")}`,
        reason: "the admin key can't create and delete API keys",
        fix: ADMIN_FIX,
      };
    const facts = `the admin key manages API keys${this.#subuser === undefined ? "" : ` of subuser ${this.#subuser}`}`;

    const id = currentId ?? idIn(current);
    if (id === null)
      return {
        ok: false,
        facts,
        reason: "the vault's value isn't a SendGrid API key, which looks like SG.<id>.<secret>",
        fix: "put the key your apps use in the vault, then run this again",
      };
    const found = await this.#request("GET", `/v3/api_keys/${encodeURIComponent(id)}`);
    if (found.status === 404 || found.status === 400)
      return {
        ok: false,
        facts,
        reason: `the admin key's ${this.#account()} has no key ${id}, ${currentId === null ? "the vault's key" : "the one keypin issued last time"}: it was deleted, or it's from another account or region`,
        fix: `check the admin key, and subuser and region in keypin.toml, against ${DASHBOARD}; if the key was deleted, make a new one there, put it in the vault and publish it, then run this again`,
      };
    if (found.status === 401 || found.status === 403) return this.#refused(found);
    if (found.status !== 200) throw failure("GET", "/v3/api_keys/<id>", found);
    const key = retrieved(found.body);
    if (key?.id !== id) throw new Error("SendGrid's GET /v3/api_keys/<id> response has no key");
    if (key.name) this.#names.set(id, key.name);
    const which = this.label(id);
    const copy = key.scopes.filter((scope) => !automatic(scope));
    const keyFacts = `${facts}; the vault holds key ${which}`;
    if (!copy.length)
      return {
        ok: false,
        facts: keyFacts,
        reason: `SendGrid shows no scopes for key ${which}, so keypin can't give the new key the same ones`,
        fix: `replace it by hand at ${DASHBOARD}`,
      };
    const ungrantable = copy.filter((scope) => !granted.includes(scope));
    if (ungrantable.length)
      return {
        ok: false,
        facts: keyFacts,
        reason: `key ${which} has ${plural(ungrantable.length, "scope")} the admin key doesn't have, so it can't give them to a new key: ${ungrantable.join(", ")}`,
        fix: `use an admin key with those scopes; a key can't grant more than it has (${DASHBOARD})`,
      };
    this.#scopes = copy;
    return {
      ok: true,
      facts: keyFacts,
      ...(currentId === null ? { currentId: id } : {}),
      notes: { create: `with the old key's ${plural(copy.length, "scope")}` },
    };
  }

  async create(name: string): Promise<IssuedKey> {
    const scopes = this.#scopes;
    if (scopes === null)
      throw new NothingChanged("refusing to create a SendGrid key: checkAccount hasn't passed");
    const created = await this.#request("POST", "/v3/api_keys", { name, scopes });
    if (created.status === 403)
      throw new NothingChanged(
        `SendGrid refused to create the key (HTTP 403): the ${this.#account()} may have 100 API keys, its most, or the admin key may not hold one of the scopes; check at ${DASHBOARD}, then run this again`,
      );
    if (created.status !== 201 && created.status !== 200)
      throw failure(
        "POST",
        "/v3/api_keys",
        created,
        created.status >= 400 && created.status < 500 ? NothingChanged : Error,
      );
    const { api_key: value, api_key_id: id } = created.body;
    if (typeof id !== "string" || !id || typeof value !== "string" || !value)
      throw new Error("SendGrid's POST /v3/api_keys response has no api_key_id and api_key");
    return { id, secret: new Secret(value) };
  }

  label(id: string): string {
    const name = this.#names.get(id);
    return name ? `"${name}"` : id;
  }

  lostCreate(name: string): string {
    return `SendGrid may have made the key before the reply was lost. Only this run uses the name "${name}": delete a key with that name${this.#subuser === undefined ? "" : ` in subuser ${this.#subuser}`} at ${DASHBOARD} before you run this again, or the rerun leaves it live.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (this.#scopes === null)
      throw new Error("refusing to revoke a SendGrid key: checkAccount hasn't passed");
    const deleted = await this.#request("DELETE", `/v3/api_keys/${encodeURIComponent(id)}`);
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403)
      throw new Error(
        `the admin key can't delete key ${this.label(id)} (HTTP ${deleted.status}): delete it at ${DASHBOARD}`,
      );
    if (deleted.status !== 204 && deleted.status !== 200)
      throw failure("DELETE", "/v3/api_keys/<id>", deleted);
    return "revoked";
  }

  #account(): string {
    return this.#subuser === undefined ? "account" : `subuser ${this.#subuser}`;
  }

  #refused(reply: Reply): IssuerCheck {
    const facts = `SendGrid answered HTTP ${reply.status}`;
    if (reply.status === 401)
      return {
        ok: false,
        facts,
        reason: `SendGrid doesn't accept the admin key: it was deleted, the item holds another value${this.#api === HOSTS.eu ? "" : `, or it's an EU regional subuser's key (set region = "eu")`}`,
        fix: ADMIN_FIX,
      };
    if ((reply.status === 403 || reply.status === 404) && this.#subuser !== undefined)
      return {
        ok: false,
        facts,
        reason: `SendGrid refused the admin key for subuser ${this.#subuser}: the subuser doesn't exist, or the admin key isn't from its parent account`,
        fix: `check subuser in keypin.toml against ${SUBUSERS}, and use a key from the parent account`,
      };
    if (reply.status === 403 || reply.status === 404)
      return { ok: false, facts, reason: "SendGrid refused the admin key", fix: ADMIN_FIX };
    throw failure("GET", "/v3/scopes", reply);
  }

  #adminKey(): Promise<Secret> {
    this.#key ??= this.#admin();
    return this.#key;
  }

  async #request(method: string, path: string, body?: unknown, onBehalf = true): Promise<Reply> {
    const key = await this.#adminKey();
    const response = await this.#fetch(`${this.#api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key.reveal()}`,
        "User-Agent": "keypin",
        ...(onBehalf && this.#subuser !== undefined ? { "on-behalf-of": this.#subuser } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

function idIn(current: Secret): string | null {
  return /^SG\.([\w-]+)\.[\w-]+$/.exec(current.reveal().trim())?.[1] ?? null;
}

function automatic(scope: string): boolean {
  return scope === "2fa_required" || scope.startsWith("sender_verification_");
}

function scopesOf(body: Record<string, unknown>): string[] {
  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  return scopes.filter((scope): scope is string => typeof scope === "string");
}

function retrieved(
  body: Record<string, unknown>,
): { id: string; name: string; scopes: string[] } | null {
  const item: unknown = Array.isArray(body.result) ? body.result[0] : body;
  if (!isRecord(item) || typeof item.api_key_id !== "string") return null;
  return {
    id: item.api_key_id,
    name: typeof item.name === "string" ? item.name : "",
    scopes: scopesOf(item),
  };
}

function failure(
  method: string,
  path: string,
  reply: Reply,
  type: new (message: string) => Error = Error,
): Error {
  return new type(`SendGrid ${method} ${path} returned HTTP ${reply.status}`);
}
