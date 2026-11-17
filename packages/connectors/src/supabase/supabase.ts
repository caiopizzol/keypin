import {
  type Fetch,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  isRecord,
  NothingChanged,
  Secret,
} from "@keypin/core";

const API = "https://api.supabase.com/v1";
const TOKENS = "https://supabase.com/dashboard/account/tokens";
const TOKEN_DOCS = "https://supabase.com/docs/guides/platform/personal-access-tokens";
const LEGACY_DOCS = "https://supabase.com/docs/guides/security/rotate-leaked-api-keys";
const FUNCTIONS_DOCS = "https://supabase.com/docs/guides/functions/auth#service-to-service-calls";
const DEFAULT = "default";
const SECRET = "sb_secret_";
const NAME_LIMIT = 64;

export interface SupabaseIssuerOptions {
  admin: () => Promise<Secret>;
  projectRef: string;
  fetch?: Fetch;
}

interface Reply {
  status: number;
  body: unknown;
}

interface Listed {
  id: string;
  name: string;
  prefix: string;
}

export class SupabaseIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #ref: string;
  readonly #fetch: Fetch;
  #key: Promise<Secret> | undefined;
  #passed = false;
  #defaults = new Set<string>();

  constructor(options: SupabaseIssuerOptions) {
    this.#admin = options.admin;
    this.#ref = options.projectRef;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return "Supabase";
  }

  dashboard(): string {
    return `https://supabase.com/dashboard/project/${encodeURIComponent(this.#ref)}/settings/api-keys`;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#passed = false;
    const vault = vaultKind(current);
    if (vault !== "secret")
      return {
        ok: false,
        facts: `the vault holds ${vault === "legacy" ? "a JWT" : vault === "publishable" ? "a publishable key" : "no sb_secret_ key"}`,
        ...refusedVault(vault),
      };
    const list = await this.#request("GET", this.#keys(""));
    if (list.status !== 200) return this.#refused(list);
    const keys = secretKeys(list.body);
    this.#defaults = new Set(keys.filter((key) => key.name === DEFAULT).map((key) => key.id));
    const facts = `project ${this.#ref} has ${keys.length} secret key${keys.length === 1 ? "" : "s"}`;
    const matches = keys.filter((key) => current.reveal().startsWith(key.prefix));
    if (matches.length > 1)
      return {
        ok: false,
        facts,
        reason: `keys ${matches.map((key) => key.name).join(" and ")} start like the vault's key, so keypin can't tell which one it holds`,
        fix: `rotate it by hand at ${this.dashboard()}`,
      };
    const held = matches[0] ?? null;
    const old = currentId === null ? held : keys.find((key) => key.id === currentId);
    if (!old) {
      if (currentId === null)
        return {
          ok: false,
          facts,
          reason: `Supabase project ${this.#ref} has no secret key that matches the vault's key`,
          fix: `check project_ref in keypin.toml; if the key was deleted, put the key your apps use in the vault, then run this again`,
        };
      return {
        ok: false,
        facts,
        reason: held
          ? `Supabase doesn't list key ${currentId}, the one keypin issued last, but lists the vault's key as ${held.name}`
          : `Supabase project ${this.#ref} lists neither key ${currentId}, the one keypin issued last, nor the vault's key`,
        fix: `check project_ref in keypin.toml; if the key was deleted, put the key your apps use in the vault, then run this again`,
      };
    }
    if (old.name === DEFAULT)
      return {
        ok: false,
        facts: `${facts}; the vault holds key ${DEFAULT}`,
        reason: `keypin won't replace the secret key named ${DEFAULT}: Edge Functions that check keys with withSupabase({ auth: 'secret' }) accept only that key, so they would reject the new one, and deleting it can't be undone`,
        fix: `create a secret key with its own name for this app at ${this.dashboard()}, put it in the vault and publish it, then rotate that one; see ${FUNCTIONS_DOCS}`,
      };
    this.#passed = true;
    return {
      ok: true,
      facts: `${facts}; ${currentId === null ? "the vault holds" : "keypin issued"} key ${old.name}`,
      ...(currentId === null ? { currentId: old.id } : {}),
      notes: {
        create:
          "the new key has a new name, so an Edge Function that checks withSupabase({ auth: 'secret:<name>' }) rejects it",
        revoke: "Supabase can't undo deleting a secret key",
      },
    };
  }

  async create(name: string): Promise<IssuedKey> {
    if (!this.#passed)
      throw new NothingChanged("refusing to create a Supabase key: checkAccount hasn't passed");
    const created = await this.#request("POST", this.#keys("?reveal=true"), {
      type: "secret",
      name: fitName(name),
    });
    if (created.status === 403)
      throw new NothingChanged(
        `Supabase refused to create a secret key (HTTP 403): the token can list project ${this.#ref}'s API keys but not create one or read its value. Give it API Keys Read-write and API Key Secrets Read; see ${TOKEN_DOCS}`,
      );
    if (created.status !== 200 && created.status !== 201)
      throw failure(
        "POST",
        "/api-keys",
        created,
        created.status >= 400 && created.status < 500 ? NothingChanged : Error,
      );
    const body = isRecord(created.body) ? created.body : {};
    const { id, api_key: value } = body;
    if (typeof id !== "string" || !id)
      throw new Error("Supabase's POST /api-keys response has no key id");
    if (typeof value !== "string" || !isSecretKey(value))
      throw new Error(
        `Supabase created key ${id} but didn't return its value: the token needs API Key Secrets Read as well as API Keys Read-write; see ${TOKEN_DOCS}`,
      );
    return { id, secret: new Secret(value) };
  }

  lostCreate(name: string): string {
    return `Supabase may have made the key before the reply was lost. Only this run uses the name "${fitName(name)}": delete a secret key with that name at ${this.dashboard()} before you run this again, or the rerun leaves it live.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#passed)
      throw new Error("refusing to delete a Supabase key: checkAccount hasn't passed");
    if (this.#defaults.has(id))
      throw new Error(
        `keypin won't delete Supabase key ${id}: it's the secret key named ${DEFAULT}`,
      );
    const deleted = await this.#request("DELETE", this.#keys(`/${encodeURIComponent(id)}`));
    if (deleted.status === 404) return "already gone";
    if (deleted.status !== 200) throw failure("DELETE", "/api-keys/<id>", deleted);
    return "revoked";
  }

  #refused(reply: Reply): IssuerCheck {
    const facts = `Supabase answered HTTP ${reply.status}`;
    if (reply.status === 401)
      return {
        ok: false,
        facts,
        reason:
          "Supabase doesn't accept the admin token: it expired or was deleted, or the item holds another value",
        fix: `put a personal access token in the admin item; create one at ${TOKENS}`,
      };
    if (reply.status === 403 || reply.status === 404)
      return {
        ok: false,
        facts,
        reason: `the admin token can't read the API keys of Supabase project ${this.#ref}: the ref is wrong, or the token isn't scoped to the project or lacks the API Keys permission`,
        fix: `check project_ref in keypin.toml, or give the token API Keys Read-write on the project; see ${TOKEN_DOCS}`,
      };
    throw failure("GET", "/api-keys", reply);
  }

  #keys(rest: string): string {
    return `/projects/${encodeURIComponent(this.#ref)}/api-keys${rest}`;
  }

  async #request(method: string, path: string, body?: unknown): Promise<Reply> {
    this.#key ??= this.#admin();
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${(await this.#key).reveal()}`,
        Accept: "application/json",
        "User-Agent": "keypin",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: parseJson(await response.text()) };
  }
}

type VaultKind = "secret" | "legacy" | "publishable" | "other";

function vaultKind(current: Secret): VaultKind {
  const value = current.reveal();
  if (value.startsWith(SECRET)) return "secret";
  if (value.startsWith("eyJ")) return "legacy";
  if (value.startsWith("sb_publishable_")) return "publishable";
  return "other";
}

function refusedVault(kind: Exclude<VaultKind, "secret">): { reason: string; fix: string } {
  if (kind === "legacy")
    return {
      reason:
        "the vault holds a legacy service_role key, which Supabase can't replace one key at a time: turning it off turns off the anon key too",
      fix: `follow ${LEGACY_DOCS}: create a secret key, move your apps to it, then turn off the legacy keys. Put the sb_secret_ key in the vault, and keypin rotates it next time`,
    };
  if (kind === "publishable")
    return {
      reason: "the vault holds a publishable key; keypin rotates only secret keys",
      fix: "use this issuer on the key that holds the project's sb_secret_ key",
    };
  return {
    reason: "the vault's value isn't a Supabase secret key (sb_secret_...)",
    fix: "put the secret key your apps use in the vault, then run this again",
  };
}

function isSecretKey(value: string): boolean {
  return value.startsWith(SECRET) && /^[A-Za-z0-9_-]+$/.test(value);
}

function secretKeys(body: unknown): Listed[] {
  const keys = Array.isArray(body) ? body : [];
  return keys.flatMap((key: unknown) =>
    isRecord(key) &&
    key.type === "secret" &&
    typeof key.id === "string" &&
    typeof key.name === "string" &&
    typeof key.prefix === "string" &&
    key.prefix.length > SECRET.length &&
    key.prefix.startsWith(SECRET)
      ? [{ id: key.id, name: key.name, prefix: key.prefix }]
      : [],
  );
}

function fitName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return words.length < NAME_LIMIT && /^[a-z]/.test(words)
    ? words
    : `_${words.slice(-(NAME_LIMIT - 1))}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function failure(
  method: string,
  path: string,
  reply: Reply,
  type: new (message: string) => Error = Error,
): Error {
  return new type(`Supabase ${method} ${path} returned HTTP ${reply.status}`);
}
