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
import { apiDisabled, call, disabledIn, type Reply, returned } from "./api";
import {
  accessToken,
  adminFix,
  OTHER_LOGINS,
  type Refusal,
  SERVICE_ACCOUNTS,
  type ServiceAccount,
  Session,
  serviceAccount,
} from "./auth";

const IAM = "https://iam.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/iam";
const ROLE = "Service Account Key Admin";
const ADMIN_FIX = adminFix(ROLE);
const LIMIT = 10;
const KEY_NAME =
  /^projects\/([a-z0-9-]+)\/serviceAccounts\/([^/?#@]+@[^/?#@]+)\/keys\/([0-9a-f]+)$/;
const POLICIES = new Set([
  "constraints/iam.disableServiceAccountKeyCreation",
  "constraints/iam.managed.disableServiceAccountKeyCreation",
]);
const KEY_FILE = "put the service account's whole JSON key file in the vault";
const WAITS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000];
const WAITED_MS = WAITS_MS.reduce((sum, ms) => sum + ms, 0);

export interface ServiceAccountKeyIssuerOptions {
  admin: () => Promise<Secret>;
  fetch?: Fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface KeyName {
  project: string;
  email: string;
  id: string;
}

interface Listed {
  id: string;
  origin: string;
  disabled: boolean;
  created: string;
}

interface Target {
  project: string;
  email: string;
  ids: string[];
}

export class ServiceAccountKeyIssuer implements Issuer {
  readonly #session: Session;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  #target: Target | null = null;
  #project: string | null = null;

  constructor(options: ServiceAccountKeyIssuerOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#session = new Session({
      admin: options.admin,
      fetch: this.#fetch,
      now: this.#now,
      scope: SCOPE,
      fix: ADMIN_FIX,
    });
  }

  describe(): string {
    return "Google Cloud IAM";
  }

  dashboard(): string {
    return this.#project === null || this.#project === "-"
      ? SERVICE_ACCOUNTS
      : `${SERVICE_ACCOUNTS}?project=${encodeURIComponent(this.#project)}`;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#target = null;
    const admin = await this.#session.account();
    if ("facts" in admin) return { ok: false, ...admin };
    const vault = vaultKey(current);
    if ("facts" in vault) return { ok: false, ...vault };
    const key = currentId === null ? vault : parseName(currentId);
    if (key === null)
      return {
        ok: false,
        facts: `keypin issued key ${currentId} last time`,
        reason: `${currentId} isn't a Google Cloud service account key name`,
        fix: `delete that key at ${SERVICE_ACCOUNTS} if it's still live, then run this again`,
      };
    this.#project = key.project;
    const which = `${currentId === null ? "the vault holds" : "keypin issued"} key ${key.id} of service account ${key.email}`;
    if (key.email !== vault.email)
      return {
        ok: false,
        facts: `${which}; the vault holds a key of ${vault.email}`,
        reason: "the vault's key belongs to another service account than the key keypin issued",
        fix: `put the key your apps use in the vault, then run this again`,
      };
    if (admin.email === key.email && admin.keyId === key.id)
      return {
        ok: false,
        facts: `the admin item holds key ${key.id} of ${key.email}, the key keypin would rotate`,
        reason: "deleting the old key would leave the admin item with a key that no longer works",
        fix: `give keypin a key of another service account, with ${ROLE} on ${key.email}; ${ADMIN_FIX}`,
      };

    const signedIn = await this.#session.bearer();
    if (typeof signedIn !== "string") return { ok: false, ...signedIn };
    const list = await call(this.#fetch, signedIn, "GET", `${keysOf(key)}?keyTypes=USER_MANAGED`);
    if (list.status !== 200) return { ok: false, ...this.#refusedList(list, key) };
    const keys = listed(list.body);
    const found = keys.find((k) => k.id === key.id);
    if (!found)
      return {
        ok: false,
        facts: which,
        reason: `Google doesn't list key ${key.id} among the user-managed keys of ${key.email}: it was deleted`,
        fix: `${KEY_FILE}, then run this again`,
      };
    if (found.origin === "USER_PROVIDED")
      return {
        ok: false,
        facts: `${which}, uploaded`,
        reason:
          "you made that key pair yourself and uploaded its public key; keypin can only ask Google to make the new key",
        fix: `rotate it by hand, or replace it once with a key created at ${this.dashboard()}`,
      };
    const others = keys.filter((k) => k.id !== key.id);
    this.#target = {
      project: key.project,
      email: key.email,
      ids: keys.map((k) => k.id),
    };
    return {
      ok: true,
      facts: found.disabled ? `${which}, disabled` : which,
      ...(currentId === null ? { currentId: nameOf(key) } : {}),
      notes: {
        create: `for ${key.email}, which has ${keys.length} of ${LIMIT} keys${others.length ? `: ${others.map(shown).join(", ")} and this one` : ""}`,
        revoke: "keypin disables it, then deletes it; a deleted key can't come back",
      },
    };
  }

  async create(): Promise<IssuedKey> {
    const target = this.#target;
    if (!target)
      throw new NothingChanged(
        "refusing to create a Google Cloud service account key: checkAccount hasn't passed",
      );
    if (target.ids.length >= LIMIT)
      throw new NothingChanged(
        `${target.email} already has ${target.ids.length} keys, the most Google allows. Delete one nothing uses at ${this.dashboard()}, then run this again`,
      );
    const bearer = await this.#session.bearer();
    if (typeof bearer !== "string") throw new NothingChanged(`${bearer.reason}: ${bearer.fix}`);
    const made = await call(this.#fetch, bearer, "POST", keysOf(target), {
      privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
    });
    if (made.status !== 200) throw this.#refusedCreate(made, target);
    const data = made.body.privateKeyData;
    const file = typeof data === "string" ? Buffer.from(data, "base64").toString("utf8") : "";
    const json = parseObject(file);
    const id = json.private_key_id;
    if (json.client_email !== target.email || typeof id !== "string" || !/^[0-9a-f]+$/.test(id))
      throw new Error(`Google's create reply has no key file for ${target.email}`);
    const secret = new Secret(file);
    const key = { ...target, id };
    const account = serviceAccount(secret, KEY_FILE);
    if ("facts" in account || !(await this.#authenticates(account)))
      await this.#discard(
        key,
        `Google didn't accept the new key ${id} of ${target.email} within ${WAITED_MS / 1000} seconds`,
      );
    target.ids = [...target.ids, id];
    return { id: nameOf(key), secret };
  }

  async #authenticates(account: ServiceAccount): Promise<boolean> {
    for (let poll = 0; poll <= WAITS_MS.length; poll++) {
      if (poll) await this.#sleep(WAITS_MS[poll - 1] ?? 0);
      const token = await accessToken(this.#fetch, account, SCOPE, this.#now()).catch(() => null);
      if (token !== null && !("facts" in token)) return true;
    }
    return false;
  }

  async #discard(key: KeyName, why: string): Promise<never> {
    try {
      await this.revoke(nameOf(key));
    } catch {
      throw new Error(
        `${why}, and keypin couldn't delete it: run gcloud iam service-accounts keys delete ${key.id} --iam-account=${key.email}, then run this again`,
      );
    }
    throw new NothingChanged(`${why}, so keypin deleted it. Run this again`);
  }

  label(id: string): string {
    return parseName(id)?.id ?? id;
  }

  lostCreate(): string {
    const target = this.#target;
    if (!target)
      return `Google may have made a service account key before the reply was lost, and keys have no name to find it by. Delete it at ${SERVICE_ACCOUNTS} before you run this again.`;
    return `Google may have made a key for ${target.email} before the reply was lost, and keys have no name to find it by. Run gcloud iam service-accounts keys list --iam-account=${target.email} --managed-by=user: keep ${target.ids.join(", ")}, and delete any other key with gcloud iam service-accounts keys delete <ID> --iam-account=${target.email} before you run this again.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#target)
      throw new Error(
        "refusing to delete a Google Cloud service account key: checkAccount hasn't passed",
      );
    const key = parseName(id);
    if (key === null) return "already gone";
    const bearer = await this.#session.bearer();
    if (typeof bearer !== "string") throw new Error(`${bearer.reason}: ${bearer.fix}`);
    const path = `${keysOf(key)}/${key.id}`;
    const read = await call(this.#fetch, bearer, "GET", path);
    if (read.status === 404) return this.#forget(key, "already gone");
    if (read.status === 401 || read.status === 403)
      throw new Error(
        `the admin service account can't read key ${key.id} of ${key.email}: ${ADMIN_FIX}, or delete the key at ${this.dashboard()}`,
      );
    if (read.status !== 200) throw new Error(returned("GET", "<account>/keys/<id>", read));
    if (read.body.disabled !== true) {
      const off = await call(this.#fetch, bearer, "POST", `${path}:disable`, {});
      if (off.status === 404) return this.#forget(key, "already gone");
      if (off.status !== 200)
        throw new Error(
          `the admin service account can't disable key ${key.id} of ${key.email} (${returned("POST", "<account>/keys/<id>:disable", off)}): ${ADMIN_FIX}, or delete the key at ${this.dashboard()}`,
        );
    }
    const deleted = await call(this.#fetch, bearer, "DELETE", path);
    if (deleted.status === 200 || deleted.status === 404) return this.#forget(key, "revoked");
    throw new Error(
      `keypin disabled key ${key.id} of ${key.email}, so it no longer works, but couldn't delete it (${returned("DELETE", "<account>/keys/<id>", deleted)}): delete it at ${this.dashboard()}`,
    );
  }

  #forget<T>(key: KeyName, result: T): T {
    const target = this.#target;
    if (target) target.ids = target.ids.filter((id) => id !== key.id);
    return result;
  }

  #refusedList(reply: Reply, key: KeyName): Refusal {
    const facts = `Google answered HTTP ${reply.status}`;
    const disabled = disabledIn(reply);
    if (disabled !== null)
      return { facts, ...apiDisabled("iam.googleapis.com", "IAM API", disabled) };
    if (reply.status === 404)
      return {
        facts,
        reason: `Google has no service account ${key.email}${key.project === "-" ? "" : ` in project ${key.project}`}: it was deleted, or the vault holds an old key file`,
        fix: `${KEY_FILE}, then run this again`,
      };
    if (reply.status === 403)
      return {
        facts,
        reason: `the admin service account can't list the keys of ${key.email}: it has no ${ROLE} role on it, or the service account was deleted`,
        fix: `grant the admin service account ${ROLE} on ${key.email}; ${ADMIN_FIX}`,
      };
    throw new Error(returned("GET", "<account>/keys", reply));
  }

  #refusedCreate(reply: Reply, target: Target): Error {
    const policy = blockedBy(reply);
    if (policy !== null) {
      return new NothingChanged(
        `the organization policy ${policy} stops new service account keys in project ${target.project}; organizations created since May 2024 have it on by default. An organization policy admin can turn it off for this project at https://console.cloud.google.com/iam-admin/orgpolicies?project=${encodeURIComponent(target.project)}, or move the app to workload identity federation, which needs no key`,
      );
    }
    if (reply.status === 401 || reply.status === 403)
      return new NothingChanged(
        `the admin service account can't create keys for ${target.email} (${returned("POST", "<account>/keys", reply)}): ${ADMIN_FIX}`,
      );
    const failed = returned("POST", "<account>/keys", reply);
    return reply.status >= 400 && reply.status < 500
      ? new NothingChanged(failed)
      : new Error(failed);
  }
}

function vaultKey(current: Secret): (KeyName & { email: string }) | Refusal {
  const json = parseObject(current.reveal());
  const type = json.type;
  const other = typeof type === "string" ? OTHER_LOGINS[type] : undefined;
  if (other)
    return {
      facts: `the vault holds ${other}`,
      reason: "keypin rotates service account keys",
      fix: KEY_FILE,
    };
  const email = json.client_email;
  const id = json.private_key_id;
  if (type !== "service_account" || typeof email !== "string" || typeof id !== "string")
    return {
      facts: "the vault holds no service account key",
      reason:
        "keypin rotates a service account's JSON key file, and needs its client_email and private_key_id",
      fix: KEY_FILE,
    };
  const project = typeof json.project_id === "string" && json.project_id ? json.project_id : "-";
  const key = parseName(`projects/${project}/serviceAccounts/${email}/keys/${id}`);
  if (key === null)
    return {
      facts: `the vault holds a key of ${email} with an ID keypin can't read`,
      reason: "a service account key ID is 40 hexadecimal characters",
      fix: KEY_FILE,
    };
  return key;
}

function parseName(name: string): KeyName | null {
  const parsed = KEY_NAME.exec(name);
  if (!parsed) return null;
  return { project: parsed[1] ?? "-", email: parsed[2] ?? "", id: parsed[3] ?? "" };
}

function nameOf(key: KeyName): string {
  return `projects/${key.project}/serviceAccounts/${key.email}/keys/${key.id}`;
}

function keysOf(key: { project: string; email: string }): string {
  return `${IAM}/projects/${key.project}/serviceAccounts/${key.email}/keys`;
}

function listed(body: Record<string, unknown>): Listed[] {
  const keys = Array.isArray(body.keys) ? body.keys : [];
  return keys.flatMap((k: unknown) => {
    if (!isRecord(k) || typeof k.name !== "string") return [];
    const name = parseName(k.name);
    if (name === null) return [];
    const text = (field: string) => (typeof k[field] === "string" ? String(k[field]) : "");
    return [
      {
        id: name.id,
        origin: text("keyOrigin"),
        disabled: k.disabled === true,
        created: text("validAfterTime"),
      },
    ];
  });
}

function blockedBy(reply: Reply): string | null {
  const details = objectField(reply.body, "error").details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (!isRecord(detail) || !Array.isArray(detail.violations)) continue;
    for (const violation of detail.violations) {
      const type = isRecord(violation) ? violation.type : undefined;
      if (typeof type === "string" && POLICIES.has(type)) return type.replace(/^constraints\//, "");
    }
  }
  return null;
}

function shown(key: Listed): string {
  const day = key.created.slice(0, 10);
  return `${key.id}${key.disabled ? " (disabled)" : ""}${day ? `, created ${day}` : ""}`;
}
