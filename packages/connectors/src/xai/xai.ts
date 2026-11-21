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
import { API, DASHBOARD, MANAGEMENT, MANAGEMENT_KEYS, PAGE, PAGES, POLL_MS, POLLS } from "./api";
import { type Copy, copies, plural, timestamp } from "./copy";
import { idOf, type Listed, listed, parseId, text, type VaultKey } from "./keys";
import { failure, type Reply, refused } from "./reply";

export interface XaiIssuerOptions {
  admin: () => Promise<Secret>;
  fetch?: Fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class XaiIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  #key: Promise<Secret> | undefined;
  #copy: Copy | null = null;
  readonly #names = new Map<string, string>();

  constructor(options: XaiIssuerOptions) {
    this.#admin = options.admin;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  describe(): string {
    return "xAI";
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
    const validation = await this.#request(MANAGEMENT, "GET", "/auth/management-keys/validation");
    if ([400, 401, 403].includes(validation.status)) return this.#notManagement(validation);
    if (validation.status !== 200)
      throw failure("GET", "/auth/management-keys/validation", validation);
    const adminTeam =
      validation.body.scope === "SCOPE_ORGANIZATION"
        ? null
        : (text(validation.body, "scopeId") ?? text(validation.body, "teamId"));

    let team: string;
    let wanted: string;
    if (currentId !== null) {
      const issued = parseId(currentId);
      if (!issued)
        return {
          ok: false,
          facts: "xAI accepts the management key",
          reason: `${currentId}, the key keypin issued last time, isn't an xAI key ID`,
          fix: `delete that key at ${DASHBOARD} if it's still live, then run this again`,
        };
      ({ team, key: wanted } = issued);
    } else {
      const vault = await this.#vaultKey(current);
      if (!vault && (await this.#isManagementKey(current)))
        return {
          ok: false,
          facts: "the vault holds a management key",
          reason:
            "keypin rotates API keys, not management keys; a management key can't call models",
          fix: `put the API key your apps use in the vault; replace a management key by hand at ${MANAGEMENT_KEYS}`,
        };
      if (!vault)
        return {
          ok: false,
          facts: "xAI doesn't accept the vault's key",
          reason:
            "keypin didn't issue the vault's key, so it can't tell whether it was deleted or the item holds another value",
          fix: `put the key your apps use in the vault, then run this again; if it was deleted, make a new one at ${DASHBOARD}`,
        };
      if (vault.off)
        return {
          ok: false,
          facts: `the vault holds key ${vault.id} of team ${vault.team}`,
          reason: `the vault's key ${vault.off}, and keypin won't make an active copy of it`,
          fix: `turn it back on at ${DASHBOARD}, or replace it by hand`,
        };
      ({ team, id: wanted } = vault);
    }
    if (adminTeam !== null && adminTeam !== team)
      return {
        ok: false,
        facts: `the management key is for team ${adminTeam}`,
        reason: `the ${currentId === null ? "vault's key" : "key keypin issued last time"} is in team ${team}`,
        fix: `use a management key from team ${team}; create one at ${MANAGEMENT_KEYS}`,
      };

    const keys = await this.#keys(team);
    if (!Array.isArray(keys)) return refused(keys, team);
    for (const key of keys) this.#names.set(key.id, key.name);
    const facts = `team ${team} lists ${plural(keys.length, "API key")}`;
    const listed = keys.find((key) => key.id === wanted);

    if (currentId !== null) {
      const vault = await this.#vaultKey(current);
      if (listed && vault?.id === wanted && vault.off)
        return {
          ok: false,
          facts: `${facts}, with ${this.label(currentId)}`,
          reason: `the vault's key ${vault.off}, and keypin won't make an active copy of it`,
          fix: `turn it back on at ${DASHBOARD}, or replace it by hand`,
        };
      if (listed) return this.#pass(team, listed, `${facts}, with ${this.label(currentId)}`);
      if (!vault)
        return {
          ok: false,
          facts: `${facts}; xAI doesn't accept the vault's key`,
          reason: `team ${team} has no key ${wanted}, the one keypin issued last time, so keypin can't copy its ACLs and rate limits`,
          fix: `make a key by hand at ${DASHBOARD}, put it in the vault and publish it, then run this again`,
        };
      return {
        ok: false,
        facts,
        reason: `team ${team} doesn't list key ${wanted}, the one keypin issued last time, but xAI still accepts the vault's key`,
        fix: `use a management key made by an admin of team ${team}, since a member's key lists only their own API keys; create one at ${MANAGEMENT_KEYS}`,
      };
    }
    if (!listed)
      return {
        ok: false,
        facts,
        reason: `none of them is the vault's key ${wanted}: the management key's owner isn't an admin of team ${team}, so it lists only their own API keys`,
        fix: `use a management key made by an admin of team ${team}; create one at ${MANAGEMENT_KEYS}`,
      };
    const passed = await this.#pass(
      team,
      listed,
      `${facts}; the vault holds ${this.label(idOf(team, listed.id))}`,
    );
    return passed.ok ? { ...passed, currentId: idOf(team, listed.id) } : passed;
  }

  async create(name: string): Promise<IssuedKey> {
    const copy = this.#copy;
    if (!copy)
      throw new NothingChanged("refusing to create an xAI key: checkAccount hasn't passed");
    const body = {
      name,
      acls: copy.acls,
      ...(copy.qps === null ? {} : { qps: copy.qps }),
      ...(copy.qpm === null ? {} : { qpm: copy.qpm }),
      ...(copy.tpm === null ? {} : { tpm: copy.tpm }),
      ...(copy.lifetime === null
        ? {}
        : { expireTime: timestamp(this.#now().getTime() + copy.lifetime) }),
    };
    const shown = "/auth/teams/<team_id>/api-keys";
    const created = await this.#request(
      MANAGEMENT,
      "POST",
      `/auth/teams/${encodeURIComponent(copy.team)}/api-keys`,
      body,
    );
    if (created.status === 401 || created.status === 403)
      throw new NothingChanged(
        `the management key can't create API keys in team ${copy.team} (HTTP ${created.status}): give it that permission, or make one that has it at ${MANAGEMENT_KEYS}`,
      );
    if (created.status !== 200 && created.status !== 201)
      throw failure(
        "POST",
        shown,
        created,
        created.status >= 400 && created.status < 500 ? NothingChanged : Error,
      );
    const { apiKeyId, apiKey } = created.body;
    if (typeof apiKeyId !== "string" || !apiKeyId || typeof apiKey !== "string" || !apiKey)
      throw new Error(`xAI's POST ${shown} response has no apiKeyId and apiKey`);
    const id = idOf(copy.team, apiKeyId);
    const stuck = await this.#propagation(apiKeyId);
    if (stuck === null) return { id, secret: new Secret(apiKey) };
    try {
      await this.revoke(id);
    } catch {
      throw new Error(
        `${stuck}, and keypin couldn't delete it: delete key ${this.label(id)} at ${DASHBOARD}, then run this again`,
      );
    }
    throw new NothingChanged(`${stuck}, so keypin deleted it. Run this again`);
  }

  label(id: string): string {
    const key = parseId(id)?.key ?? id;
    const name = this.#names.get(key);
    return name ? `"${name}"` : key;
  }

  lostCreate(name: string): string {
    const team = this.#copy ? ` in team ${this.#copy.team}` : "";
    return `xAI may have made the key before the reply was lost. Only this run uses the name "${name}": delete a key with that name${team} at ${DASHBOARD} before you run this again, or the rerun leaves it live.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#copy) throw new Error("refusing to revoke an xAI key: checkAccount hasn't passed");
    const parsed = parseId(id);
    if (!parsed) return "already gone";
    const deleted = await this.#request(
      MANAGEMENT,
      "DELETE",
      `/auth/api-keys/${encodeURIComponent(parsed.key)}`,
    );
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403)
      throw new Error(
        `the management key can't delete key ${this.label(id)} (HTTP ${deleted.status}): give it that permission at ${MANAGEMENT_KEYS}, or delete the key at ${DASHBOARD}`,
      );
    if (deleted.status !== 200) throw failure("DELETE", "/auth/api-keys/<id>", deleted);
    return "revoked";
  }

  async #pass(team: string, key: Listed, facts: string): Promise<IssuerCheck> {
    if (key.disabled)
      return {
        ok: false,
        facts: `${facts}, disabled`,
        reason: `key ${this.label(key.id)} is disabled at xAI, and keypin won't make an active copy of it`,
        fix: `turn it back on at ${DASHBOARD}, or replace it by hand`,
      };
    if (!key.acls.length)
      return {
        ok: false,
        facts,
        reason: `xAI shows no ACLs for key ${this.label(key.id)}, so a copy couldn't call any model or endpoint`,
        fix: `give it the models and endpoints your apps use at ${DASHBOARD}, then run this again`,
      };
    const lifetime =
      key.expireTime === null || key.createTime === null
        ? null
        : Date.parse(key.expireTime) - Date.parse(key.createTime);
    if (key.expireTime !== null && (lifetime === null || !(lifetime > 0)))
      return {
        ok: false,
        facts,
        reason: `keypin can't tell how long key ${this.label(key.id)} lasts, so it can't give the new key the same lifetime`,
        fix: `replace it by hand at ${DASHBOARD}`,
      };
    const path = `/auth/api-keys/${encodeURIComponent(key.id)}/propagation`;
    const propagation = await this.#request(MANAGEMENT, "GET", path);
    if (propagation.status === 401 || propagation.status === 403)
      return {
        ok: false,
        facts,
        reason:
          "the management key can't check whether a key has reached every xAI cluster, so keypin couldn't wait for the new key before publishing it",
        fix: `give the management key the CheckApiKeyPropagation permission, or make one that has it at ${MANAGEMENT_KEYS}`,
      };
    if (propagation.status !== 200)
      throw failure("GET", "/auth/api-keys/<id>/propagation", propagation);
    const copy: Copy = {
      team,
      acls: key.acls,
      qps: key.qps,
      qpm: key.qpm,
      tpm: key.tpm,
      lifetime,
    };
    this.#copy = copy;
    return { ok: true, facts, notes: { create: copies(copy) } };
  }

  async #propagation(id: string): Promise<string | null> {
    const path = `/auth/api-keys/${encodeURIComponent(id)}/propagation`;
    let pending: string[] = [];
    for (let poll = 0; poll < POLLS; poll++) {
      if (poll) await this.#sleep(POLL_MS);
      const reply = await this.#request(MANAGEMENT, "GET", path).catch(() => null);
      if (reply === null || reply.status === 429 || reply.status >= 500) continue;
      if (reply.status !== 200)
        return `keypin couldn't check whether the new key ${id} reached every xAI cluster: GET /auth/api-keys/<id>/propagation returned HTTP ${reply.status}`;
      const clusters = Object.entries(
        isRecord(reply.body.icPropagation) ? reply.body.icPropagation : {},
      );
      pending = clusters.filter(([, done]) => done !== true).map(([cluster]) => cluster);
      if (clusters.length && !pending.length) return null;
    }
    const waiting = pending.length ? ` (still waiting on ${pending.join(", ")})` : "";
    return `xAI didn't report the new key ${id} on every cluster within ${(POLLS * POLL_MS) / 1000} seconds${waiting}`;
  }

  async #notManagement(reply: Reply): Promise<IssuerCheck> {
    const facts = `xAI answered HTTP ${reply.status} to the management key`;
    const fix = `put a management key in the admin item; create one at ${MANAGEMENT_KEYS}`;
    const asApiKey = await this.#request(API, "GET", "/v1/api-key");
    if (asApiKey.status === 200)
      return {
        ok: false,
        facts,
        reason:
          "the admin item holds an xAI API key, not a management key, and API keys can't create or delete keys",
        fix,
      };
    return {
      ok: false,
      facts,
      reason:
        "xAI doesn't accept the management key: it was deleted, it's limited to other IP addresses, or the item holds another value",
      fix,
    };
  }

  async #isManagementKey(key: Secret): Promise<boolean> {
    const reply = await this.#request(
      MANAGEMENT,
      "GET",
      "/auth/management-keys/validation",
      undefined,
      key,
    );
    return reply.status === 200;
  }

  async #vaultKey(current: Secret): Promise<VaultKey | null> {
    const reply = await this.#request(API, "GET", "/v1/api-key", undefined, current);
    if ([400, 401, 403].includes(reply.status)) return null;
    if (reply.status !== 200) throw failure("GET", "/v1/api-key with the vault's key", reply);
    const id = text(reply.body, "api_key_id");
    const team = text(reply.body, "team_id");
    if (!id || !team)
      throw new Error("xAI's GET /v1/api-key response has no api_key_id and team_id");
    const off =
      reply.body.api_key_disabled === true
        ? "is disabled"
        : reply.body.api_key_blocked === true
          ? "is blocked"
          : reply.body.team_blocked === true
            ? `belongs to team ${team}, which xAI blocked`
            : null;
    return { id, team, off };
  }

  async #keys(team: string): Promise<Listed[] | Reply> {
    const keys: Listed[] = [];
    let token: string | null = null;
    for (let page = 0; page < PAGES; page++) {
      const cursor: string = token === null ? "" : `&paginationToken=${encodeURIComponent(token)}`;
      const reply = await this.#request(
        MANAGEMENT,
        "GET",
        `/auth/teams/${encodeURIComponent(team)}/api-keys?pageSize=${PAGE}${cursor}`,
      );
      if (reply.status !== 200) return reply;
      const data = Array.isArray(reply.body.apiKeys) ? reply.body.apiKeys : [];
      keys.push(...data.flatMap(listed));
      const next = text(reply.body, "paginationToken");
      if (!data.length || next === null || next === token) return keys;
      token = next;
    }
    throw new Error(`xAI team ${team} lists more than ${PAGE * PAGES} API keys`);
  }

  #adminKey(): Promise<Secret> {
    this.#key ??= this.#admin();
    return this.#key;
  }

  async #request(
    base: string,
    method: string,
    path: string,
    body?: unknown,
    as?: Secret,
  ): Promise<Reply> {
    const key = as ?? (await this.#adminKey());
    const response = await this.#fetch(`${base}${path}`, {
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
