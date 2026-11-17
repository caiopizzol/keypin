import {
  type Fetch,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  isRecord,
  NothingChanged,
  objectField,
  Secret,
} from "@keypin/core";
import { call, disabledIn, type Reply, returned, statusOf } from "./api";
import { ADMIN_FIX, accessToken, type Refusal, serviceAccount } from "./auth";

const CREDENTIALS = "https://console.cloud.google.com/apis/credentials";
const KEY_NAME = /^projects\/([^/]+)\/locations\/global\/keys\/([^/]+)$/;
const KEY_ID_LIMIT = 63;
const KEY_PREFIX = "AIza";
const POLL_MS = 2000;
const POLLS = 30;

export interface GoogleIssuerOptions {
  admin: () => Promise<Secret>;
  projectNumber: string;
  fetch?: Fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface Key {
  name: string;
  displayName: string;
  restrictions: Record<string, unknown>;
  serviceAccountEmail: string;
  deleted: boolean;
}

interface Copy {
  project: string;
  restrictions: Record<string, unknown>;
}

export class GoogleIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #pinned: string;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  #token: { token: string; until: number } | null = null;
  #copy: Copy | null = null;
  #project: string | null = null;
  readonly #names = new Map<string, string>();

  constructor(options: GoogleIssuerOptions) {
    this.#admin = options.admin;
    this.#pinned = options.projectNumber;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  describe(): string {
    return "Google Cloud";
  }

  dashboard(): string {
    return this.#project === null
      ? CREDENTIALS
      : `${CREDENTIALS}?project=${encodeURIComponent(this.#project)}`;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#copy = null;
    const signedIn = await this.#bearer();
    if (typeof signedIn !== "string") return { ok: false, ...signedIn };

    let name = currentId;
    if (name === null) {
      if (!current.reveal().startsWith(KEY_PREFIX))
        return {
          ok: false,
          facts: "the vault holds a value that doesn't start with AIza",
          reason:
            "keypin rotates Google Cloud API keys, which start with AIza, and the item holds another value",
          fix: `put the API key your apps use in the vault; find it at ${CREDENTIALS}`,
        };
      const found = await this.#request(
        "GET",
        `keys:lookupKey?keyString=${encodeURIComponent(current.reveal())}`,
      );
      if (found.status !== 200) return this.#refusedLookup(found);
      const { name: listed, parent } = found.body;
      if (typeof listed !== "string" || !KEY_NAME.test(listed)) {
        const project = typeof parent === "string" ? ` in ${parent}` : "";
        return {
          ok: false,
          facts: `Google knows the vault's key${project}, but no longer lists it`,
          reason:
            "the key was deleted more than 30 days ago, so keypin can't read its restrictions",
          fix: `create a key by hand at ${CREDENTIALS}, put it in the vault and publish it, then run this again`,
        };
      }
      name = listed;
    }
    const parsed = KEY_NAME.exec(name);
    if (!parsed)
      return {
        ok: false,
        facts: `keypin issued key ${name} last time`,
        reason: `${name} isn't a Google Cloud API key name`,
        fix: `delete that key at ${CREDENTIALS} if it's still live, then run this again`,
      };
    this.#project = parsed[1] ?? null;
    if (this.#project !== this.#pinned)
      return {
        ok: false,
        facts: `${currentId === null ? "the vault's key is" : "keypin issued a key"} in project ${this.#project}`,
        reason: `keypin.toml pins project_number ${this.#pinned}, and the key is in project ${this.#project}`,
        fix: `check project_number in keypin.toml, and that the vault holds the key from project ${this.#pinned}`,
      };

    const read = await this.#request("GET", name);
    if (read.status !== 200) return this.#refusedRead(read, name, currentId !== null);
    const key = parseKey(read.body, name);
    this.#names.set(key.name, key.displayName);
    const which = `${currentId === null ? "the vault holds" : "keypin issued"} key ${this.label(key.name)} in project ${this.#project}`;
    if (key.deleted)
      return {
        ok: false,
        facts: `${which}, deleted`,
        reason: `key ${this.label(key.name)} is deleted at Google Cloud, and keypin won't make a live copy of it`,
        fix: `restore it under Restore deleted credentials at ${this.dashboard()}, or replace it by hand`,
      };
    if (key.serviceAccountEmail)
      return {
        ok: false,
        facts: `${which}, bound to service account ${key.serviceAccountEmail}`,
        reason: "keypin doesn't copy a key bound to a service account yet",
        fix: `replace it by hand at ${this.dashboard()}`,
      };
    this.#copy = {
      project: this.#project ?? "",
      restrictions: key.restrictions,
    };
    return {
      ok: true,
      facts: which,
      ...(currentId === null ? { currentId: key.name } : {}),
      notes: { create: copies(key), revoke: "Google Cloud can restore it for 30 days" },
    };
  }

  async create(name: string): Promise<IssuedKey> {
    const copy = this.#copy;
    if (!copy)
      throw new NothingChanged("refusing to create a Google Cloud key: checkAccount hasn't passed");
    const bearer = await this.#bearer();
    if (typeof bearer !== "string") throw new NothingChanged(`${bearer.reason}: ${bearer.fix}`);
    const parent = `projects/${copy.project}/locations/global`;
    const body = {
      displayName: name.slice(0, KEY_ID_LIMIT),
      ...(Object.keys(copy.restrictions).length ? { restrictions: copy.restrictions } : {}),
    };
    const created = await this.#request("POST", `${parent}/keys?keyId=${keyIdOf(name)}`, body);
    if (created.status === 401 || created.status === 403)
      throw new NothingChanged(
        `the admin service account can't create keys in project ${copy.project} (${returned("POST", "<project>/keys", created)}): ${ADMIN_FIX}`,
      );
    if (created.status !== 200)
      throw created.status >= 400 && created.status < 500
        ? new NothingChanged(returned("POST", "<project>/keys", created))
        : new Error(returned("POST", "<project>/keys", created));
    const done = await this.#finished(created.body, "creating");
    const error = objectField(done, "error");
    if (Object.keys(error).length)
      throw new NothingChanged(
        `Google Cloud didn't create the key: the operation ended with ${statusOf(error) ?? `code ${String(error.code)}`}`,
      );
    const id = objectField(done, "response").name;
    if (typeof id !== "string" || !KEY_NAME.test(id))
      throw new Error("Google's finished create operation has no key name");
    const value = await this.#keyString(id, objectField(done, "response").keyString);
    return { id, secret: new Secret(value) };
  }

  label(id: string): string {
    const short = KEY_NAME.exec(id)?.[2] ?? id;
    const name = this.#names.get(id);
    return name ? `"${name}" (${short})` : short;
  }

  lostCreate(name: string): string {
    return `Google Cloud may have made the key, or may still be making it. Only this run uses key ID ${keyIdOf(name)} and the name "${name.slice(0, KEY_ID_LIMIT)}": delete that key at ${this.dashboard()} before you run this again, or the rerun leaves it live.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#copy)
      throw new Error("refusing to delete a Google Cloud key: checkAccount hasn't passed");
    if (!KEY_NAME.test(id)) return "already gone";
    const read = await this.#request("GET", id);
    if (read.status === 404) return "already gone";
    if (read.status === 200 && parseKey(read.body, id).deleted) return "already gone";
    const deleted = await this.#request("DELETE", id);
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403)
      throw new Error(
        `the admin service account can't delete key ${this.label(id)}: ${ADMIN_FIX}, or delete it at ${this.dashboard()}`,
      );
    if (deleted.status !== 200) throw new Error(returned("DELETE", "<project>/keys/<id>", deleted));
    const done = await this.#finished(deleted.body, "deleting");
    if (Object.keys(objectField(done, "error")).length)
      throw new Error(
        `Google Cloud didn't delete key ${this.label(id)}: delete it at ${this.dashboard()}`,
      );
    return "revoked";
  }

  async #keyString(id: string, given: unknown): Promise<string> {
    if (typeof given === "string" && given) return given;
    const read = await this.#request("GET", `${id}/keyString`);
    const value = read.body.keyString;
    if (read.status !== 200 || typeof value !== "string" || !value)
      throw new Error(
        `Google Cloud made key ${this.label(id)} but didn't return its value (${returned("GET", "<project>/keys/<id>/keyString", read)})`,
      );
    return value;
  }

  async #finished(
    operation: Record<string, unknown>,
    doing: string,
  ): Promise<Record<string, unknown>> {
    let latest = operation;
    for (let poll = 0; latest.done !== true; poll++) {
      const name = latest.name;
      if (poll === POLLS || typeof name !== "string" || !/^operations\/[^/?#]+$/.test(name))
        throw new Error(
          `Google Cloud hasn't finished ${doing} the key after ${(POLLS * POLL_MS) / 1000} seconds`,
        );
      await this.#sleep(POLL_MS);
      const reply = await this.#request("GET", name);
      if (reply.status !== 200) throw new Error(returned("GET", "operations/<id>", reply));
      latest = reply.body;
    }
    return latest;
  }

  #refusedLookup(reply: Reply): IssuerCheck {
    const facts = `Google answered HTTP ${reply.status}`;
    const disabled = disabledIn(reply);
    if (disabled !== null) return { ok: false, facts, ...apiDisabled(disabled) };
    if (reply.status === 400 || reply.status === 404)
      return {
        ok: false,
        facts,
        reason:
          "Google Cloud doesn't know the vault's key: it was deleted, or the item holds another value",
        fix: "put the key your apps use in the vault",
      };
    if (reply.status === 403)
      return {
        ok: false,
        facts,
        reason:
          "the admin service account can't look up the vault's key: it has no API Keys Admin role on the key's project",
        fix: `grant the service account API Keys Admin on the project that owns the key; ${ADMIN_FIX}`,
      };
    throw new Error(returned("GET", "keys:lookupKey", reply));
  }

  #refusedRead(reply: Reply, name: string, issued: boolean): IssuerCheck {
    const facts = `Google answered HTTP ${reply.status}`;
    const disabled = disabledIn(reply);
    if (disabled !== null) return { ok: false, facts, ...apiDisabled(disabled) };
    if (reply.status === 403)
      return {
        ok: false,
        facts,
        reason: `the admin service account can't read the API keys of project ${this.#project}`,
        fix: `grant it API Keys Admin on project ${this.#project}; ${ADMIN_FIX}`,
      };
    if (reply.status === 404)
      return {
        ok: false,
        facts,
        reason: issued
          ? `Google Cloud has no key ${name}, the one keypin issued last time, so keypin can't copy its restrictions`
          : `Google Cloud has no key ${name}`,
        fix: `create a key by hand at ${this.dashboard()}, put it in the vault and publish it, then run this again`,
      };
    throw new Error(returned("GET", "<project>/keys/<id>", reply));
  }

  async #bearer(): Promise<string | Refusal> {
    if (this.#token && this.#token.until > this.#now().getTime()) return this.#token.token;
    const account = serviceAccount(await this.#admin());
    if ("facts" in account) return account;
    const token = await accessToken(this.#fetch, account, this.#now());
    if ("facts" in token) return token;
    this.#token = token;
    return token.token;
  }

  async #request(method: string, path: string, body?: unknown): Promise<Reply> {
    const bearer = await this.#bearer();
    if (typeof bearer !== "string") throw new Error(`${bearer.reason}: ${bearer.fix}`);
    return call(this.#fetch, bearer, method, path, body);
  }
}

function apiDisabled(project: string): { reason: string; fix: string } {
  const where = project ? ` in project ${project}` : "";
  return {
    reason: `the API Keys API is turned off${where}, the admin service account's project`,
    fix: `turn on apikeys.googleapis.com at https://console.cloud.google.com/apis/library/apikeys.googleapis.com${project ? `?project=${encodeURIComponent(project)}` : ""}`,
  };
}

function parseKey(body: Record<string, unknown>, name: string): Key {
  const text = (field: string) => {
    const value = body[field];
    return typeof value === "string" ? value : "";
  };
  return {
    name: text("name") || name,
    displayName: text("displayName"),
    restrictions: objectField(body, "restrictions"),
    serviceAccountEmail: text("serviceAccountEmail"),
    deleted: text("deleteTime") !== "",
  };
}

function copies(key: Key): string {
  const r = key.restrictions;
  const list = (field: string, inner: string) => {
    const value = objectField(r, field)[inner];
    return Array.isArray(value) ? value.length : 0;
  };
  const targets = Array.isArray(r.apiTargets)
    ? r.apiTargets.flatMap((t: unknown) =>
        isRecord(t) && typeof t.service === "string" ? [t.service] : [],
      )
    : [];
  const kept = [
    ...(targets.length
      ? [`API ${targets.length === 1 ? "target" : "targets"} ${targets.join(", ")}`]
      : []),
    ...counted(list("browserKeyRestrictions", "allowedReferrers"), "website", "websites"),
    ...counted(list("serverKeyRestrictions", "allowedIps"), "IP address", "IP addresses"),
    ...counted(
      list("androidKeyRestrictions", "allowedApplications"),
      "Android app",
      "Android apps",
    ),
    ...counted(list("iosKeyRestrictions", "allowedBundleIds"), "iOS app", "iOS apps"),
  ];
  if (!kept.length) return "with no restrictions, like the old key";
  const joined = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
  return `with the old key's ${joined}`;
}

function counted(n: number, one: string, many: string): string[] {
  return n ? [`${n} ${n === 1 ? one : many}`] : [];
}

export function keyIdOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= KEY_ID_LIMIT && /^[a-z]/.test(slug)) return slug;
  return `k-${slug.slice(-(KEY_ID_LIMIT - 2)).replace(/^-+/, "")}`;
}
