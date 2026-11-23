import {
  type Expiry,
  type Fetch,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  NothingChanged,
  objectField,
  Secret,
} from "@keypin/core";
import { call, type Reply, returned } from "./api";
import {
  type Copy,
  copies,
  DAY,
  fitName,
  parseToken,
  plural,
  timestamp,
  tokenKind,
} from "./token-record";

const USER_TOKENS = "https://dash.cloudflare.com/profile/api-tokens";
const ACCOUNT_TOKENS = "https://dash.cloudflare.com/?to=/:account/api-tokens";
const CREATE_DOCS = "https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/";
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const BROAD = /\badmin\b|API Tokens (?:Write|Edit)/i;

export interface CloudflareIssuerOptions {
  admin: () => Promise<Secret>;
  accountId?: string;
  fetch?: Fetch;
  now?: () => Date;
}

export class CloudflareIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #account: string | null;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  #key: Promise<Secret> | undefined;
  #copy: Copy | null = null;
  readonly #names = new Map<string, string>();

  constructor(options: CloudflareIssuerOptions) {
    if (options.accountId !== undefined && !ACCOUNT_ID.test(options.accountId))
      throw new Error(`"${options.accountId}" isn't a Cloudflare account ID`);
    this.#admin = options.admin;
    this.#account = options.accountId ?? null;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  describe(): string {
    return "Cloudflare";
  }

  dashboard(): string {
    return this.#account === null ? USER_TOKENS : ACCOUNT_TOKENS;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#copy = null;
    const kind = this.#account === null ? "user API token" : "account API token";
    const held = tokenKind(current) ?? kind;
    const facts = `the vault holds ${/^[aeiouAEIOU]/.test(held) ? "an" : "a"} ${held}`;
    const refused = this.#refusesValue(current);
    if (refused) return { ok: false, facts, ...refused };
    const admin = await this.#adminKey();
    const adminKind = tokenKind(admin);
    if (adminKind === "Global API Key" || adminKind === "wrangler login token")
      return {
        ok: false,
        facts: `the admin item holds a ${adminKind}`,
        reason: `keypin creates tokens with an API token, not a ${adminKind}`,
        fix: this.#adminFix(),
      };
    if (admin.equals(current))
      return {
        ok: false,
        facts: "the admin item and the key's item hold the same token",
        reason:
          "the admin token is the token keypin would rotate, and deleting the old token would leave the admin item with a token that no longer works",
        fix: `put a separate token that can create tokens in the admin item; see ${CREATE_DOCS}`,
      };

    let id = currentId;
    if (id === null) {
      const verified = await this.#request("GET", "/verify", undefined, current);
      if (verified.status !== 200 || typeof objectField(verified.body, "result").id !== "string")
        return { ok: false, facts, ...this.#unverified(verified) };
      id = String(objectField(verified.body, "result").id);
    }

    const read = await this.#request("GET", `/${encodeURIComponent(id)}`);
    if (read.status !== 200) return this.#refusedRead(read, id, currentId !== null);
    const token = parseToken(read.body, id);
    if (!token)
      throw new Error(
        `Cloudflare's GET ${this.#base()}/<id> response has no policies keypin can read`,
      );
    this.#names.set(token.id, token.name);
    const which = `${currentId === null ? "the vault holds" : "keypin issued"} ${kind} ${this.label(token.id)}`;
    if (token.status === "disabled")
      return {
        ok: false,
        facts: `${which}, disabled`,
        reason: `token ${this.label(token.id)} is disabled at Cloudflare, and keypin won't make an active copy of it`,
        fix: `turn it back on at ${this.dashboard()}, or replace it by hand`,
      };
    const start = token.notBefore ?? token.issuedOn;
    const lifetime =
      token.expiresOn === null || start === null
        ? null
        : Date.parse(token.expiresOn) - Date.parse(start);
    const unreadable = token.notBefore !== null && Number.isNaN(Date.parse(token.notBefore));
    if (unreadable || (token.expiresOn !== null && (lifetime === null || !(lifetime > 0))))
      return {
        ok: false,
        facts: which,
        reason: `keypin can't tell how long token ${this.label(token.id)} lasts, so it can't give the new token the same lifetime`,
        fix: `replace it by hand at ${this.dashboard()}`,
      };
    const ahead = token.notBefore !== null && Date.parse(token.notBefore) > this.#now().getTime();
    this.#copy = {
      policies: token.policies,
      permissions: token.permissions,
      condition: token.condition,
      notBefore: ahead ? token.notBefore : null,
      lifetime,
    };
    const broad = token.permissions.filter((name) => BROAD.test(name));
    return {
      ok: true,
      facts: `${which}, with ${plural(token.policies.length, "policy", "policies")}`,
      ...(currentId === null ? { currentId: token.id } : {}),
      notes: { create: copies(this.#copy) },
      ...(lifetime === null ? {} : { lifetimeDays: lifetime / DAY }),
      ...(broad.length
        ? {
            warnings: [
              `the new token copies ${broad.join(", ")} from token ${this.label(token.id)}. If it doesn't need ${broad.length === 1 ? "that" : "those"}, make a narrower token at ${this.dashboard()}, publish it, check what uses it still works, then delete the old one.`,
            ],
          }
        : {}),
    };
  }

  async checkAdmin(): Promise<Expiry | null> {
    const verified = await this.#request("GET", "/verify");
    const result = objectField(verified.body, "result");
    if (verified.status !== 200 || typeof result.id !== "string")
      throw new Error(
        `Cloudflare doesn't accept the admin token (${returned("GET", `${this.#base()}/verify`, verified)}): ${this.#adminFix()}`,
      );
    if (typeof result.status === "string" && result.status !== "active")
      throw new Error(`the admin token is ${result.status} at Cloudflare: ${this.#adminFix()}`);
    if (typeof result.expires_on !== "string" || !result.expires_on) return null;
    return {
      credential: "the Cloudflare admin token",
      at: result.expires_on,
      renew: `give it a later expiry at ${this.dashboard()}, or ${this.#adminFix()}`,
    };
  }

  async create(name: string): Promise<IssuedKey> {
    const copy = this.#copy;
    if (!copy)
      throw new NothingChanged("refusing to create a Cloudflare token: checkAccount hasn't passed");
    const now = this.#now().getTime();
    const start = copy.notBefore === null ? now : Date.parse(copy.notBefore);
    const body = {
      name: fitName(name),
      policies: copy.policies,
      ...(copy.condition === null ? {} : { condition: copy.condition }),
      ...(copy.notBefore === null ? {} : { not_before: copy.notBefore }),
      ...(copy.lifetime === null ? {} : { expires_on: timestamp(start + copy.lifetime) }),
    };
    const created = await this.#request("POST", "", body);
    if (created.status === 401 || created.status === 403)
      throw new NothingChanged(
        `the admin token can't create Cloudflare tokens with these permissions (${returned("POST", this.#base(), created)}): ${this.#adminFix()}`,
      );
    if (created.status !== 200) {
      const hidden = [(await this.#adminKey()).reveal()];
      const where = returned("POST", this.#base(), created, hidden);
      throw created.status >= 400 && created.status < 500
        ? new NothingChanged(where)
        : new Error(where);
    }
    const { id, value } = objectField(created.body, "result");
    if (typeof id !== "string" || !id || typeof value !== "string" || !value)
      throw new Error(`Cloudflare's POST ${this.#base()} response has no token id and value`);
    return { id, secret: new Secret(value) };
  }

  label(id: string): string {
    const name = this.#names.get(id);
    return name ? `"${name}"` : id;
  }

  lostCreate(name: string): string {
    return `Cloudflare may have made the token before the reply was lost. Only this run uses the name "${fitName(name)}": delete a token with that name at ${this.dashboard()} before you run this again, or the rerun leaves it live.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#copy)
      throw new Error("refusing to delete a Cloudflare token: checkAccount hasn't passed");
    const deleted = await this.#request("DELETE", `/${encodeURIComponent(id)}`);
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403)
      throw new Error(
        `the admin token can't delete token ${this.label(id)}: ${this.#adminFix()}, or delete it at ${this.dashboard()}`,
      );
    if (deleted.status !== 200)
      throw new Error(returned("DELETE", `${this.#base()}/<id>`, deleted));
    return "revoked";
  }

  #refusesValue(current: Secret): { reason: string; fix: string } | null {
    const kind = tokenKind(current);
    if (kind === "Global API Key")
      return {
        reason: "keypin rotates API tokens, not the Global API Key",
        fix: `move your apps to an API token from ${USER_TOKENS}, put it in the vault, then run this again`,
      };
    if (kind === "wrangler login token")
      return {
        reason: "wrangler refreshes its login token itself; keypin rotates API tokens",
        fix: `use an API token from ${USER_TOKENS} instead`,
      };
    if (kind === "account API token" && this.#account === null)
      return {
        reason: "the vault holds an account API token (cfat_), and the issuer has no account_id",
        fix: "add account_id, the account the token belongs to, to the issuer in secretspec.toml",
      };
    if (kind === "user API token" && this.#account !== null)
      return {
        reason: `the vault holds a user API token (cfut_), and the issuer's account_id makes keypin look for an account API token`,
        fix: "remove account_id from the issuer in secretspec.toml",
      };
    return null;
  }

  #unverified(reply: Reply): { reason: string; fix: string } {
    if (
      reply.status === 200 ||
      reply.status === 400 ||
      reply.status === 401 ||
      reply.status === 403
    )
      return {
        reason:
          this.#account === null
            ? "Cloudflare doesn't accept the vault's token as a user API token: it was deleted or expired, it's an account API token, or the item holds another value"
            : `Cloudflare doesn't accept the vault's token as an account API token of account ${this.#account}: it was deleted or expired, it's a user API token or from another account, or the item holds another value`,
        fix:
          this.#account === null
            ? "put the token your apps use in the vault; for an account API token, add account_id to the issuer"
            : "check account_id in secretspec.toml, and put the token your apps use in the vault",
      };
    throw new Error(returned("GET", `${this.#base()}/verify with the vault's token`, reply));
  }

  #refusedRead(reply: Reply, id: string, issued: boolean): IssuerCheck {
    const facts = `Cloudflare answered HTTP ${reply.status}`;
    if (reply.status === 400 || reply.status === 401)
      return {
        ok: false,
        facts,
        reason:
          "Cloudflare doesn't accept the admin token: it was deleted or expired, or the item holds another value",
        fix: this.#adminFix(),
      };
    if (reply.status === 403)
      return {
        ok: false,
        facts,
        reason: `the admin token can't read ${this.#account === null ? "its user's" : `account ${this.#account}'s`} API tokens`,
        fix: this.#adminFix(),
      };
    if (reply.status === 404)
      return {
        ok: false,
        facts,
        reason: issued
          ? `Cloudflare has no token ${id}, the one keypin issued last time, so keypin can't copy its permissions`
          : this.#account === null
            ? `the admin token's user has no token ${id}: the vault's token belongs to another Cloudflare user`
            : `the admin token can't see token ${id} in account ${this.#account}: the token is from another account, or the admin token's creator isn't a Super Administrator and didn't make it`,
        fix: issued
          ? `create a token by hand at ${this.dashboard()}, put it in the vault and publish it, then run this again`
          : this.#account === null
            ? "put a token that can create tokens for the same user in the admin item"
            : "check account_id in secretspec.toml, or have a Super Administrator make the admin token",
      };
    throw new Error(returned("GET", `${this.#base()}/<id>`, reply));
  }

  #adminFix(): string {
    return this.#account === null
      ? `put a token made with the "Create additional tokens" template in the admin item; create one at ${USER_TOKENS}`
      : `put a token with Account API Tokens Edit on account ${this.#account} in the admin item; create one at ${ACCOUNT_TOKENS}`;
  }

  #base(): string {
    return this.#account === null ? "/user/tokens" : `/accounts/${this.#account}/tokens`;
  }

  #adminKey(): Promise<Secret> {
    this.#key ??= this.#admin();
    return this.#key;
  }

  async #request(method: string, rest: string, body?: unknown, as?: Secret): Promise<Reply> {
    const key = as ?? (await this.#adminKey());
    return call(this.#fetch, key.reveal(), method, `${this.#base()}${rest}`, body);
  }
}
