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
import { type Copy, copies, fitName, plural, timestamp } from "./copy";
import { type Listed, listed, shownAs, text, type VaultKey } from "./keys";

const API = "https://openrouter.ai/api/v1";
const DASHBOARD = "https://openrouter.ai/settings/keys";
const MANAGEMENT_KEYS = "https://openrouter.ai/settings/management-keys";
const PAGE = 100;
const PAGES = 100;

export interface OpenRouterIssuerOptions {
  admin: () => Promise<Secret>;
  fetch?: Fetch;
  now?: () => Date;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export class OpenRouterIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  #key: Promise<Secret> | undefined;
  #copy: Copy | null = null;
  readonly #names = new Map<string, string>();

  constructor(options: OpenRouterIssuerOptions) {
    this.#admin = options.admin;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  describe(): string {
    return "OpenRouter";
  }

  dashboard(): string {
    return DASHBOARD;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#copy = null;
    if ((await this.#adminKey()).equals(current))
      return {
        ok: false,
        facts: "the admin item and the key's item hold the same key",
        reason:
          "the vault's key is the management key keypin signs in with, and keypin rotates API keys, not management keys",
        fix: `put a management key in the admin item and the API key your apps use in the vault; create a management key at ${MANAGEMENT_KEYS}`,
      };
    const vault = await this.#vaultKey(current);
    if (vault?.management)
      return {
        ok: false,
        facts: "the vault holds a management key",
        reason: "keypin rotates API keys, not management keys; a management key can't call models",
        fix: `put the API key your apps use in the vault; replace a management key by hand at ${MANAGEMENT_KEYS}`,
      };

    if (currentId !== null) {
      const read = await this.#request("GET", `/keys/${encodeURIComponent(currentId)}`);
      if (read.status === 404) {
        if (!vault)
          return {
            ok: false,
            facts: "OpenRouter doesn't accept the vault's key",
            reason: `OpenRouter has no key ${currentId}, the one keypin issued last time, so keypin can't copy its credit limit`,
            fix: `create a key by hand at ${DASHBOARD}, put it in the vault and publish it, then run this again`,
          };
        return {
          ok: false,
          facts: "OpenRouter still accepts the vault's key",
          reason: `the management key doesn't list key ${currentId}, the one keypin issued last time`,
          fix: `use a management key from the account or workspace that has the key at ${DASHBOARD}`,
        };
      }
      if (read.status !== 200) return this.#refused(read, null, "/keys/<hash>");
      const key = listed(read.body.data);
      if (!key)
        throw new Error("OpenRouter's GET /keys/<hash> response has no key keypin can read");
      this.#names.set(key.hash, key.name);
      if (key.disabled) return this.#disabled(key, `keypin issued key ${this.label(key.hash)}`);
      if (!vault)
        return {
          ok: false,
          facts: `keypin issued key ${this.label(key.hash)}`,
          reason: `OpenRouter doesn't accept the vault's key, but still lists key ${this.label(key.hash)}, the one keypin issued last time`,
          fix: `put key ${this.label(key.hash)} in the vault, then run this again`,
        };
      return this.#pass(key, vault, `keypin issued key ${this.label(key.hash)}`);
    }

    const keys = await this.#keys(vault?.workspaceId ?? null);
    if (!Array.isArray(keys)) return this.#refused(keys, vault?.workspaceId ?? null, "/keys");
    const facts = `the management key lists ${plural(keys.length, "API key")}`;
    if (!vault) {
      const disabled = keys.find((key) => key.disabled && shownAs(key.label, current));
      if (disabled) {
        this.#names.set(disabled.hash, disabled.name);
        return this.#disabled(disabled, `${facts}; the vault holds ${this.label(disabled.hash)}`);
      }
      return {
        ok: false,
        facts: `${facts}; OpenRouter doesn't accept the vault's key`,
        reason:
          "OpenRouter doesn't accept the vault's key: it was deleted, disabled or expired, or the item holds another value",
        fix: `put the key your apps use in the vault, then run this again; if it's gone, make a new one at ${DASHBOARD}`,
      };
    }
    const matches = keys.filter((key) => key.label === vault.label);
    const [match, ...more] = matches;
    if (!match)
      return {
        ok: false,
        facts,
        reason: `none of them is the vault's key (${vault.label}): the management key belongs to another account or workspace`,
        fix: `use a management key from the account or workspace that has the key at ${DASHBOARD}`,
      };
    for (const key of matches) this.#names.set(key.hash, key.name);
    if (more.length)
      return {
        ok: false,
        facts,
        reason: `${matches.length} keys show the same label as the vault's key (${matches.map((key) => this.label(key.hash)).join(", ")}), so keypin can't tell which one it is`,
        fix: `delete the keys nothing uses at ${DASHBOARD}, then run this again`,
      };
    const passed = await this.#pass(
      match,
      vault,
      `${facts}; the vault holds ${this.label(match.hash)}`,
    );
    return passed.ok ? { ...passed, currentId: match.hash } : passed;
  }

  async create(name: string): Promise<IssuedKey> {
    const copy = this.#copy;
    if (!copy)
      throw new NothingChanged("refusing to create an OpenRouter key: checkAccount hasn't passed");
    const body = {
      name: fitName(name),
      ...(copy.limit === null ? {} : { limit: copy.limit }),
      ...(copy.limitReset === null ? {} : { limit_reset: copy.limitReset }),
      include_byok_in_limit: copy.includeByok,
      ...(copy.lifetime === null
        ? {}
        : { expires_at: timestamp(this.#now().getTime() + copy.lifetime) }),
      ...(copy.workspaceId === null ? {} : { workspace_id: copy.workspaceId }),
      ...(copy.creatorUserId === null ? {} : { creator_user_id: copy.creatorUserId }),
    };
    const created = await this.#request("POST", "/keys", body);
    if (created.status === 401 || created.status === 403)
      throw new NothingChanged(
        `the management key can't create keys (HTTP ${created.status}): put a read/write management key in the admin item; create one at ${MANAGEMENT_KEYS}`,
      );
    if (created.status !== 200 && created.status !== 201) {
      const where = `OpenRouter POST /keys returned HTTP ${created.status}`;
      throw created.status >= 400 && created.status < 500
        ? new NothingChanged(where)
        : new Error(where);
    }
    const data = isRecord(created.body.data) ? created.body.data : {};
    const { hash } = data;
    const value = created.body.key;
    if (typeof hash !== "string" || !hash || typeof value !== "string" || !value)
      throw new Error("OpenRouter's POST /keys response has no hash and key");
    return { id: hash, secret: new Secret(value) };
  }

  label(id: string): string {
    const name = this.#names.get(id);
    return name ? `"${name}"` : id;
  }

  lostCreate(name: string): string {
    return `OpenRouter may have made the key before the reply was lost. Only this run uses the name "${fitName(name)}": delete a key with that name at ${DASHBOARD} before you run this again, or the rerun leaves it live.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#copy)
      throw new Error("refusing to delete an OpenRouter key: checkAccount hasn't passed");
    const deleted = await this.#request("DELETE", `/keys/${encodeURIComponent(id)}`);
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403)
      throw new Error(
        `the management key can't delete key ${this.label(id)} (HTTP ${deleted.status}): delete it at ${DASHBOARD}`,
      );
    if (deleted.status !== 200)
      throw new Error(`OpenRouter DELETE /keys/<hash> returned HTTP ${deleted.status}`);
    return "revoked";
  }

  #disabled(key: Listed, facts: string): IssuerCheck {
    return {
      ok: false,
      facts: `${facts}, disabled`,
      reason: `key ${this.label(key.hash)} is disabled at OpenRouter, and keypin won't make an active copy of it`,
      fix: `turn it back on at ${DASHBOARD}, or replace it by hand`,
    };
  }

  async #pass(key: Listed, vault: VaultKey, facts: string): Promise<IssuerCheck> {
    if (key.disabled) return this.#disabled(key, facts);
    const tied = vault.keyBudget ? "a guardrail budget of its own" : await this.#tiedTo(key);
    if (tied)
      return {
        ok: false,
        facts,
        reason: `key ${this.label(key.hash)} has ${tied}, and a new key wouldn't get it`,
        fix: `replace it by hand at ${DASHBOARD}, and give the new key the same guardrail, BYOK or observability access`,
      };
    const lifetime =
      key.expiresAt === null || key.createdAt === null
        ? null
        : Date.parse(key.expiresAt) - Date.parse(key.createdAt);
    if (key.expiresAt !== null && (lifetime === null || !(lifetime > 0)))
      return {
        ok: false,
        facts,
        reason: `keypin can't tell how long key ${this.label(key.hash)} lasts, so it can't give the new key the same lifetime`,
        fix: `replace it by hand at ${DASHBOARD}`,
      };
    this.#copy = {
      limit: key.limit,
      limitReset: key.limit === null ? null : key.limitReset,
      includeByok: key.includeByok,
      lifetime,
      workspaceId: key.workspaceId,
      creatorUserId: vault.organizationId === null ? null : key.creatorUserId,
    };
    return { ok: true, facts, notes: { create: copies(this.#copy, key.limitRemaining) } };
  }

  async #vaultKey(current: Secret): Promise<VaultKey | null> {
    const reply = await this.#request("GET", "/key", undefined, current);
    if (reply.status === 401 || reply.status === 403) return null;
    const data = isRecord(reply.body.data) ? reply.body.data : null;
    if (reply.status !== 200 || !data || typeof data.label !== "string")
      throw new Error(`OpenRouter GET /key with the vault's key returned HTTP ${reply.status}`);
    const budgets = Array.isArray(data.budgets) ? data.budgets : [];
    return {
      label: data.label,
      management: data.is_management_key === true || data.is_provisioning_key === true,
      organizationId: text(data, "organization_id"),
      workspaceId: text(data, "workspace_id"),
      keyBudget: budgets.some((budget) => isRecord(budget) && budget.scope === "api_key"),
    };
  }

  async #keys(workspace: string | null): Promise<Listed[] | Reply> {
    const keys: Listed[] = [];
    const where = workspace === null ? "" : `&workspace_id=${encodeURIComponent(workspace)}`;
    for (let offset = 0, page = 0; page < PAGES; page++) {
      const reply = await this.#request(
        "GET",
        `/keys?include_disabled=true&offset=${offset}${where}`,
      );
      if (reply.status !== 200) return reply;
      const data = Array.isArray(reply.body.data) ? reply.body.data : [];
      if (!data.length) return keys;
      keys.push(...data.map(listed).filter((key) => key !== null));
      offset += data.length;
    }
    throw new Error(`OpenRouter lists more than ${PAGE * PAGES} API keys`);
  }

  async #tiedTo(key: Listed): Promise<string | null> {
    const guardrails = await this.#all("/guardrails/assignments/keys", key.workspaceId);
    if (guardrails.some((assigned) => assigned.key_hash === key.hash))
      return "a guardrail assigned to it";
    const byok = await this.#all("/byok", key.workspaceId);
    const limited = byok.some(
      (credential) =>
        Array.isArray(credential.allowed_api_key_hashes) &&
        credential.allowed_api_key_hashes.includes(key.hash),
    );
    if (limited) return "a BYOK provider key limited to it";
    const destinations = await this.#all("/observability/destinations", key.workspaceId);
    const traced = destinations.some(
      (destination) =>
        destination.enabled === true &&
        Array.isArray(destination.api_key_hashes) &&
        destination.api_key_hashes.includes(key.hash),
    );
    return traced ? "an observability destination limited to it" : null;
  }

  async #all(path: string, workspace: string | null): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    const where = workspace === null ? "" : `&workspace_id=${encodeURIComponent(workspace)}`;
    for (let page = 0; page < PAGES; page++) {
      const reply = await this.#request(
        "GET",
        `${path}?limit=${PAGE}&offset=${items.length}${where}`,
      );
      if (reply.status !== 200)
        throw new Error(`OpenRouter GET ${path} returned HTTP ${reply.status}`);
      const data = Array.isArray(reply.body.data) ? reply.body.data.filter(isRecord) : [];
      items.push(...data);
      const total = reply.body.total_count;
      if (!data.length || (typeof total === "number" && items.length >= total)) return items;
    }
    throw new Error(`OpenRouter GET ${path} lists more than ${PAGE * PAGES} items`);
  }

  #refused(reply: Reply, workspace: string | null, path: string): IssuerCheck {
    const facts = `OpenRouter answered HTTP ${reply.status}`;
    const fix = `put a read/write management key in the admin item; create one at ${MANAGEMENT_KEYS}`;
    if (reply.status === 401)
      return {
        ok: false,
        facts,
        reason:
          "OpenRouter doesn't accept the management key: it isn't a management key, it expired or was deleted, or the item holds another value",
        fix,
      };
    if (reply.status === 403)
      return {
        ok: false,
        facts,
        reason: `the management key can't list keys${workspace === null ? "" : ` in workspace ${workspace}, the vault key's workspace`}: it's scoped to another workspace`,
        fix: `${fix}, in that workspace or for the whole organization`,
      };
    if ((reply.status === 400 || reply.status === 404) && workspace !== null)
      return {
        ok: false,
        facts,
        reason: `the management key's account has no workspace ${workspace}, the vault key's workspace: the vault's key is from another account`,
        fix: `use a management key from the account that has the key at ${DASHBOARD}`,
      };
    throw new Error(`OpenRouter GET ${path} returned HTTP ${reply.status}`);
  }

  #adminKey(): Promise<Secret> {
    this.#key ??= this.#admin();
    return this.#key;
  }

  async #request(method: string, path: string, body?: unknown, as?: Secret): Promise<Reply> {
    const key = as ?? (await this.#adminKey());
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
