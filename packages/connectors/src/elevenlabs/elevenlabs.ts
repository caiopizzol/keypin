import {
  type Fetch,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  NothingChanged,
  objectField,
  parseObject,
  RevokeRefused,
  Secret,
} from "@keypin/core";
import { idOf, type Listed, listedKeys, numberIn, parseId } from "./keys";
import { ADMIN_FIX, missingPermission, refusedAdmin, type Reply, returned } from "./refusal";

const API = "https://api.elevenlabs.io/v1";
const DASHBOARD = "https://elevenlabs.io/app/workspace";
const SERVICE_ACCOUNTS = `Workspace settings → Service Accounts (${DASHBOARD})`;
const MAX_LIFETIME = 90 * 86_400;
const DAY = 86_400;

export interface ElevenLabsIssuerOptions {
  admin: () => Promise<Secret>;
  fetch?: Fetch;
  now?: () => Date;
}

interface Copy {
  account: string;
  permissions: string[];
  characterLimit: number | null;
  allowedIps: string[] | null;
  thirdPartyDisable: boolean | null;
  concurrency: Record<string, number>;
  lifetime: number | null;
}

const CONCURRENCY = [
  ["concurrency", "tts_concurrency_limit"],
  ["dubbing_concurrency", "dubbing_concurrency_limit"],
  ["music_concurrency", "music_concurrency_limit"],
] as const;

export class ElevenLabsIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  #key: Promise<Secret> | undefined;
  #copy: Copy | null = null;
  readonly #names = new Map<string, string>();

  constructor(options: ElevenLabsIssuerOptions) {
    this.#admin = options.admin;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  describe(): string {
    return "ElevenLabs";
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
        reason: "the vault's key is the admin key keypin signs in with",
        fix: `put the service account key your apps use in the vault, and a workspace admin's key in its own admin item`,
      };
    const accounts = await this.#request("GET", "/service-accounts");
    if (accounts.status !== 200) return refusedAdmin(accounts);
    const keys = listedKeys(accounts.body);
    const count = Array.isArray(accounts.body["service-accounts"])
      ? accounts.body["service-accounts"].length
      : 0;
    const facts = `the admin key lists ${plural(count, "service account")}`;
    for (const key of keys) this.#names.set(idOf(key), key.name);

    if (currentId !== null) {
      const key = keys.find((listed) => idOf(listed) === currentId);
      if (!key)
        return {
          ok: false,
          facts,
          reason: `the admin key's workspace has no key ${this.label(currentId)}, the one keypin issued last time`,
          fix: `if it still works, use an admin key from its workspace; otherwise create a service account key by hand in ${SERVICE_ACCOUNTS}, put it in the vault and publish it, then run this again`,
        };
      const owner = await this.#owner(current);
      if (owner !== null && owner !== key.account)
        return {
          ok: false,
          facts,
          reason: `key ${this.label(currentId)}, the one keypin recorded for the vault's value, belongs to service account "${key.accountName}", not to ${accountOf(keys, owner)}, which owns the vault's key`,
          fix: "check .keypin/rotation.json for a change you didn't make",
        };
      return this.#pass(key, `${facts}; keypin issued key ${this.label(currentId)}`);
    }

    const user = await this.#request("GET", "/user", current);
    if (user.status === 401 || user.status === 403) {
      if (missingPermission(user))
        return {
          ok: false,
          facts: `${facts}; the vault's key can't read its own user`,
          reason:
            "the vault's key has no User read permission, so ElevenLabs doesn't tell keypin which service account it belongs to",
          fix: `give the key the User read permission in ${SERVICE_ACCOUNTS}, then run this again; the new key keeps it`,
        };
      if (user.status === 403)
        return {
          ok: false,
          facts: `${facts}; ElevenLabs refused the vault's key here`,
          reason:
            "ElevenLabs refused the vault's key from this machine: the key's IP allowlist may not include this address, or the key was disabled",
          fix: `run this from an address the key allows, or check its IP allowlist in ${SERVICE_ACCOUNTS}, then run this again`,
        };
      return {
        ok: false,
        facts: `${facts}; ElevenLabs doesn't accept the vault's key`,
        reason:
          "ElevenLabs doesn't accept the vault's key: it was deleted, disabled or expired, or the item holds another value",
        fix: `put the key your apps use in the vault, then run this again; if it's gone, make a new one in ${SERVICE_ACCOUNTS}`,
      };
    }
    const owner = user.body.user_id;
    if (user.status !== 200 || typeof owner !== "string" || !owner)
      throw new Error(`ElevenLabs GET /v1/user with the vault's key returned HTTP ${user.status}`);
    const owned = keys.filter((key) => key.account === owner);
    if (!owned.length)
      return {
        ok: false,
        facts: `${facts}; none of them owns the vault's key`,
        reason:
          "the vault's key belongs to a person, not a service account, or to another workspace; ElevenLabs' API makes keys only for service accounts",
        fix: `replace it once with a key from a service account in ${SERVICE_ACCOUNTS}, or use an admin key from the key's workspace`,
      };
    const accountName = owned[0]?.accountName ?? owner;
    const live = this.#live(owned);
    const [match, ...more] = live;
    if (!match)
      throw new Error(
        `ElevenLabs accepts the vault's key, but lists no active key for service account "${accountName}"`,
      );
    if (more.length)
      return {
        ok: false,
        facts: `${facts}; service account "${accountName}" has ${plural(live.length, "active key")}`,
        reason: `keypin can't tell which of service account "${accountName}"'s keys (${live.map((key) => this.label(idOf(key))).join(", ")}) the vault holds`,
        fix: `delete the keys nothing uses, or give each app its own service account, in ${SERVICE_ACCOUNTS}`,
      };
    const passed = this.#pass(
      match,
      `${facts}; the vault holds ${this.label(idOf(match))} of service account "${accountName}"`,
    );
    return passed.ok ? { ...passed, currentId: idOf(match) } : passed;
  }

  async create(name: string): Promise<IssuedKey> {
    const copy = this.#copy;
    if (!copy)
      throw new NothingChanged("refusing to create an ElevenLabs key: checkAccount hasn't passed");
    const body = {
      name,
      permissions: copy.permissions,
      ...(copy.characterLimit === null ? {} : { character_limit: copy.characterLimit }),
      ...(copy.allowedIps === null ? {} : { allowed_ips: copy.allowedIps }),
      ...(copy.thirdPartyDisable === null
        ? {}
        : { third_party_disable_allowed: copy.thirdPartyDisable }),
      ...copy.concurrency,
      ...(copy.lifetime === null
        ? {}
        : { expires_at_unix: Math.floor(this.#now().getTime() / 1000) + copy.lifetime }),
    };
    const path = `/service-accounts/${encodeURIComponent(copy.account)}/api-keys`;
    const created = await this.#request("POST", path, undefined, body);
    if (created.status === 401 || created.status === 403)
      throw new NothingChanged(
        `the admin key can't create service account keys (HTTP ${created.status}): ${ADMIN_FIX}`,
      );
    if (created.status !== 200 && created.status !== 201) {
      const where = returned("POST", "/v1/service-accounts/<id>/api-keys", created);
      throw created.status >= 400 && created.status < 500
        ? new NothingChanged(where)
        : new Error(where);
    }
    const keyId = created.body.key_id;
    const value = created.body["xi-api-key"];
    if (typeof keyId !== "string" || !keyId || typeof value !== "string" || !value)
      throw new Error("ElevenLabs' create response has no key_id and xi-api-key");
    return { id: `${copy.account}/${keyId}`, secret: new Secret(value) };
  }

  label(id: string): string {
    const name = this.#names.get(id);
    return name ? `"${name}"` : (parseId(id)?.keyId ?? id);
  }

  lostCreate(name: string): string {
    return `ElevenLabs may have made the key before the reply was lost. Only this run uses the name "${name}": delete a key with that name in ${SERVICE_ACCOUNTS} before you run this again, or the rerun leaves it live.`;
  }

  async revoke(id: string, current: Secret): Promise<"revoked" | "already gone"> {
    if (!this.#copy)
      throw new Error("refusing to delete an ElevenLabs key: checkAccount hasn't passed");
    const parsed = parseId(id);
    if (!parsed) return "already gone";
    const owner = await this.#owner(current);
    if (owner === null)
      throw new RevokeRefused("keypin can't tell which service account the vault's key belongs to");
    const keys = await this.#listed();
    if (parsed.account !== owner)
      throw new RevokeRefused(
        `it belongs to ${accountOf(keys, parsed.account)}, not to ${accountOf(keys, owner)}, which owns the vault's key`,
      );
    const owned = keys.filter((key) => key.account === owner);
    const target = owned.find((key) => key.keyId === parsed.keyId);
    if (!target) return "already gone";
    const live = this.#live(owned);
    if (live.length === 1 && live[0] === target)
      throw new RevokeRefused(
        `it's the only active key of ${accountOf(keys, owner)}, so it's the key the vault holds`,
      );
    const path = `/service-accounts/${encodeURIComponent(parsed.account)}/api-keys/${encodeURIComponent(parsed.keyId)}`;
    const deleted = await this.#request("DELETE", path);
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403)
      throw new Error(
        `the admin key can't delete key ${this.label(id)} (HTTP ${deleted.status}): delete it in ${SERVICE_ACCOUNTS}`,
      );
    if (deleted.status !== 200)
      throw new Error(returned("DELETE", "/v1/service-accounts/<id>/api-keys/<key_id>", deleted));
    return "revoked";
  }

  async has(id: string): Promise<boolean> {
    const parsed = parseId(id);
    if (!parsed) return false;
    const keys = await this.#listed();
    return keys.some((key) => key.account === parsed.account && key.keyId === parsed.keyId);
  }

  async #listed(): Promise<Listed[]> {
    const accounts = await this.#request("GET", "/service-accounts");
    if (accounts.status !== 200) throw new Error(returned("GET", "/v1/service-accounts", accounts));
    return listedKeys(accounts.body);
  }

  #live(keys: Listed[]): Listed[] {
    const now = this.#now().getTime() / 1000;
    return keys.filter((key) => !key.disabled && (key.expiresAt === null || key.expiresAt > now));
  }

  async #owner(current: Secret): Promise<string | null> {
    const user = await this.#request("GET", "/user", current);
    if (user.status >= 500) throw new Error(returned("GET", "/v1/user", user));
    const owner = user.body.user_id;
    return user.status === 200 && typeof owner === "string" && owner ? owner : null;
  }

  #pass(key: Listed, facts: string): IssuerCheck {
    const which = this.label(idOf(key));
    const byHand = `replace it by hand in ${SERVICE_ACCOUNTS}`;
    if (key.disabled)
      return {
        ok: false,
        facts: `${facts}, disabled${key.disableReason ? ` (${key.disableReason})` : ""}`,
        reason: `key ${which} is disabled at ElevenLabs, and keypin won't make an active copy of it`,
        fix: `turn it back on in ${SERVICE_ACCOUNTS}, or ${byHand}`,
      };
    if (key.permissions === null)
      return {
        ok: false,
        facts,
        reason: `ElevenLabs doesn't show key ${which}'s permissions, so keypin can't give the new key the same ones`,
        fix: `restrict the key to the permissions it needs in ${SERVICE_ACCOUNTS}, then run this again`,
      };
    const credits = numberIn(objectField(key.limits, "credits"));
    if (credits !== null && credits !== key.characterLimit)
      return {
        ok: false,
        facts,
        reason: `key ${which} has a credit limit keypin can't copy`,
        fix: byHand,
      };
    if (numberIn(objectField(key.limits, "pvc")) !== null)
      return {
        ok: false,
        facts,
        reason: `key ${which} has a Professional Voice Clone limit, and a new key wouldn't get it`,
        fix: byHand,
      };
    let lifetime: number | null = null;
    if (key.expiresAt !== null) {
      if (key.createdAt === null || key.expiresAt <= key.createdAt)
        return {
          ok: false,
          facts,
          reason: `keypin can't tell how long key ${which} lasts, so it can't give the new key the same lifetime`,
          fix: byHand,
        };
      lifetime = Math.min(key.expiresAt - key.createdAt, MAX_LIFETIME);
    }
    const concurrency: Record<string, number> = {};
    for (const [limit, field] of CONCURRENCY) {
      const value = numberIn(objectField(key.limits, limit));
      if (value !== null) concurrency[field] = value;
    }
    this.#copy = {
      account: key.account,
      permissions: key.permissions,
      characterLimit: key.characterLimit,
      allowedIps: key.allowedIps,
      thirdPartyDisable: key.thirdPartyDisable,
      concurrency,
      lifetime,
    };
    return { ok: true, facts, notes: { create: copies(this.#copy, key.accountName) } };
  }

  #adminKey(): Promise<Secret> {
    this.#key ??= this.#admin();
    return this.#key;
  }

  async #request(method: string, path: string, as?: Secret, body?: unknown): Promise<Reply> {
    const key = as ?? (await this.#adminKey());
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        "xi-api-key": key.reveal(),
        "User-Agent": "keypin",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

function copies(copy: Copy, accountName: string): string {
  const limit =
    copy.characterLimit === null
      ? "no credit limit"
      : `the old key's limit of ${copy.characterLimit.toLocaleString("en-US")} credits a month, starting unspent`;
  const ips =
    copy.allowedIps === null ? "" : `, ${plural(copy.allowedIps.length, "allowed IP range")}`;
  const concurrent = Object.keys(copy.concurrency).length ? ", the same concurrency limits" : "";
  const expires =
    copy.lifetime === null
      ? "no expiry"
      : `expiring ${plural(Math.ceil(copy.lifetime / DAY), "day")} after it's made`;
  return `for service account "${accountName}", with the old key's ${plural(copy.permissions.length, "permission")}, ${limit}${ips}${concurrent}; ${expires}`;
}

function accountOf(keys: Listed[], account: string): string {
  const name = keys.find((key) => key.account === account)?.accountName;
  return name ? `service account "${name}"` : `service account ${account}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
