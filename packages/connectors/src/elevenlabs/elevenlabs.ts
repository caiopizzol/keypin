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

const API = "https://api.elevenlabs.io/v1";
const DASHBOARD = "https://elevenlabs.io/app/workspace";
const SERVICE_ACCOUNTS = `Workspace settings → Service Accounts (${DASHBOARD})`;
const ADMIN_FIX =
  "put a workspace admin's API key in the admin item; a restricted key needs access to service accounts";
const MAX_LIFETIME = 90 * 86_400;
const DAY = 86_400;

export interface ElevenLabsIssuerOptions {
  admin: () => Promise<Secret>;
  fetch?: Fetch;
  now?: () => Date;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

interface Listed {
  account: string;
  accountName: string;
  keyId: string;
  name: string;
  disabled: boolean;
  disableReason: string | null;
  permissions: string[] | null;
  characterLimit: number | null;
  allowedIps: string[] | null;
  thirdPartyDisable: boolean | null;
  limits: Record<string, unknown>;
  createdAt: number | null;
  expiresAt: number | null;
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
    const now = this.#now().getTime() / 1000;
    const live = owned.filter(
      (key) => !key.disabled && (key.expiresAt === null || key.expiresAt > now),
    );
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

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#copy)
      throw new Error("refusing to delete an ElevenLabs key: checkAccount hasn't passed");
    const parsed = parseId(id);
    if (!parsed) return "already gone";
    const path = `/service-accounts/${encodeURIComponent(parsed.account)}/api-keys`;
    const listed = await this.#request("GET", path);
    if (listed.status === 404) return "already gone";
    if (listed.status !== 200)
      throw new Error(returned("GET", "/v1/service-accounts/<id>/api-keys", listed));
    const keys = Array.isArray(listed.body["api-keys"]) ? listed.body["api-keys"] : [];
    if (!keys.some((key) => isRecord(key) && key.key_id === parsed.keyId)) return "already gone";
    const deleted = await this.#request("DELETE", `${path}/${encodeURIComponent(parsed.keyId)}`);
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403)
      throw new Error(
        `the admin key can't delete key ${this.label(id)} (HTTP ${deleted.status}): delete it in ${SERVICE_ACCOUNTS}`,
      );
    if (deleted.status !== 200)
      throw new Error(returned("DELETE", "/v1/service-accounts/<id>/api-keys/<key_id>", deleted));
    return "revoked";
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

function refusedAdmin(reply: Reply): IssuerCheck {
  const facts = `ElevenLabs answered HTTP ${reply.status}`;
  if (reply.status === 401 && !missingPermission(reply))
    return {
      ok: false,
      facts,
      reason:
        "ElevenLabs doesn't accept the admin key: it was deleted, disabled or expired, or the item holds another value",
      fix: ADMIN_FIX,
    };
  if (reply.status === 403 && !missingPermission(reply))
    return {
      ok: false,
      facts,
      reason:
        "ElevenLabs refused the admin key from this machine: its IP allowlist may not include this address, or it can't list service accounts",
      fix: `run this from an address the admin key allows, or check its IP allowlist; ${ADMIN_FIX}`,
    };
  if (reply.status === 401 || reply.status === 403)
    return {
      ok: false,
      facts,
      reason:
        "the admin key can't list service accounts: only a workspace admin's key with access to service accounts can",
      fix: ADMIN_FIX,
    };
  throw new Error(returned("GET", "/v1/service-accounts", reply));
}

function missingPermission(reply: Reply): boolean {
  const detail = objectField(reply.body, "detail");
  return detail.code === "missing_permissions" || detail.status === "missing_permissions";
}

function listedKeys(body: Record<string, unknown>): Listed[] {
  const accounts = Array.isArray(body["service-accounts"]) ? body["service-accounts"] : [];
  return accounts.filter(isRecord).flatMap((account) => {
    const id = text(account, "service_account_user_id");
    if (id === null) return [];
    const accountName = text(account, "name") ?? id;
    const keys = Array.isArray(account["api-keys"]) ? account["api-keys"] : [];
    return keys.filter(isRecord).flatMap((key) => {
      const keyId = text(key, "key_id");
      if (keyId === null) return [];
      return [
        {
          account: text(key, "service_account_user_id") ?? id,
          accountName,
          keyId,
          name: text(key, "name") ?? "",
          disabled: key.is_disabled === true,
          disableReason: text(key, "disable_reason"),
          permissions: strings(key.permissions),
          characterLimit: number(key.character_limit),
          allowedIps: strings(key.allowed_ips)?.length ? strings(key.allowed_ips) : null,
          thirdPartyDisable:
            typeof key.third_party_disable_allowed === "boolean"
              ? key.third_party_disable_allowed
              : null,
          limits: objectField(key, "platform_limits"),
          createdAt: number(key.created_at_unix),
          expiresAt: number(key.expires_at_unix),
        },
      ];
    });
  });
}

function idOf(key: Listed): string {
  return `${key.account}/${key.keyId}`;
}

function parseId(id: string): { account: string; keyId: string } | null {
  const parsed = /^([^/]+)\/([^/]+)$/.exec(id);
  return parsed?.[1] && parsed[2] ? { account: parsed[1], keyId: parsed[2] } : null;
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

function numberIn(limit: Record<string, unknown>): number | null {
  return number(limit.limit);
}

function number(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function text(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value ? value : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function returned(method: string, path: string, reply: Reply): string {
  const code = objectField(reply.body, "detail").code;
  return `ElevenLabs ${method} ${path} returned HTTP ${reply.status}${typeof code === "string" && code ? ` ${code}` : ""}`;
}
