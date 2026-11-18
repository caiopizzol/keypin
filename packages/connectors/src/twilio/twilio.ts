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
import {
  type Admin,
  ADMIN_FIX,
  adminCredentials,
  DASHBOARD,
  ACCOUNT_SID,
  KEY_SID,
  MANAGE,
  type Refusal,
} from "./admin";

export const API = "https://api.twilio.com";
export const IAM = "https://iam.twilio.com";
const NAME_LIMIT = 64;
const NOT_AUTHORIZED = 70051;

export interface TwilioIssuerOptions {
  admin: () => Promise<Secret>;
  fetch?: Fetch;
}

interface Reply {
  status: number;
  code: number | null;
  body: Record<string, unknown>;
}

interface Target {
  account: string;
  current: string;
  policy: string[] | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export class TwilioIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #fetch: Fetch;
  #credentials: Promise<Admin | Refusal> | undefined;
  #target: Target | null = null;

  constructor(options: TwilioIssuerOptions) {
    this.#admin = options.admin;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return "Twilio";
  }

  dashboard(): string {
    return DASHBOARD;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#target = null;
    const admin = await this.#adminKey();
    if ("facts" in admin) return { ok: false, ...admin };
    const refused = refusesId(currentId);
    if (refused) return { ok: false, ...refused };
    const id = currentId ?? "";
    if (id === admin.key)
      return {
        ok: false,
        facts: `the admin item holds API key ${id}, the key keypin would rotate`,
        reason: "deleting the old key would leave the admin item with a key that no longer works",
        fix: `give keypin a separate admin credential; ${ADMIN_FIX}`,
      };

    if (admin.key !== null) {
      const own = await this.#request(admin, "GET", `${IAM}/v1/Keys/${admin.key}`);
      if (own.status !== 200) return adminRefused(admin, own);
      const lacking = MANAGE.filter((p) => !(policyOf(own.body) ?? MANAGE).includes(p));
      if (lacking.length)
        return {
          ok: false,
          facts: `the admin item holds Restricted key ${admin.key}, without ${lacking.join(", ")}`,
          reason: "the admin key can't create, read and delete API keys",
          fix: ADMIN_FIX,
        };
    }

    const found = await this.#request(admin, "GET", `${IAM}/v1/Keys/${id}`);
    if (found.status === 404)
      return {
        ok: false,
        facts: `account ${admin.account} has no API key ${id}`,
        reason:
          "the key was deleted, or it belongs to another account; for a subaccount's key, the admin item needs the subaccount's own SID and credential",
        fix: `check the key at ${DASHBOARD}; if it was deleted, make one there, put it in the vault and publish it, then run this again`,
      };
    if (found.status !== 200) return adminRefused(admin, found);
    const policy = policyOf(found.body);
    const name = typeof found.body.friendly_name === "string" ? found.body.friendly_name : "";
    const facts = `the vault holds ${policy === null ? "API key" : "Restricted key"} ${id}${name ? ` "${name}"` : ""} of account ${admin.account}`;

    const vault = { account: admin.account, user: id, password: current.reveal(), key: id };
    const signs = await this.#request(
      vault,
      "GET",
      `${API}/2010-04-01/Accounts/${admin.account}/AvailablePhoneNumbers.json`,
    );
    if (signs.status !== 200 && policy !== null && signs.code === NOT_AUTHORIZED)
      return {
        ok: false,
        facts: `${facts}; Twilio answered ${answered(signs)} to it`,
        reason: `keypin can't confirm the vault's secret works: Twilio gives this answer when Restricted key ${id} lacks permission to read available phone numbers, but also when the key or account is suspended`,
        fix: `check at ${DASHBOARD} that the key and account are active, and give the key permission to read available phone numbers, then run this again`,
      };
    if (signs.status !== 200) {
      if (signs.status !== 401 && signs.status !== 403)
        throw failure("GET", "AvailablePhoneNumbers", signs);
      return {
        ok: false,
        facts: `${facts}; Twilio answered ${answered(signs)} to it`,
        reason: `the vault's secret isn't the secret of API key ${id}, or the key can't sign in to account ${admin.account}`,
        fix: "put the API key SID and its secret, from the same key, in the vault, then run this again",
      };
    }

    if (policy === null) {
      const main = await this.#request(
        vault,
        "GET",
        `${IAM}/v1/Keys?AccountSid=${admin.account}&PageSize=1`,
      );
      if (main.status !== 200 && main.status !== 401 && main.status !== 403)
        throw failure("GET", "/v1/Keys", main);
      if (main.status === 200)
        return {
          ok: false,
          facts: `${facts}, a Main key`,
          reason:
            "Twilio's API makes only Standard and Restricted keys, so the new key would lose the old key's access to accounts and keys",
          fix: `replace it by hand with a Main key at ${DASHBOARD}, or give the app a Standard or Restricted key`,
        };
    }

    this.#target = { account: admin.account, current: id, policy };
    return {
      ok: true,
      facts,
      currentId: id,
      notes: {
        create:
          policy === null
            ? "a Standard key, like the old one"
            : `a Restricted key with the old key's ${plural(policy.length, "permission")}`,
      },
    };
  }

  async create(name: string): Promise<IssuedKey> {
    const target = this.#target;
    if (!target)
      throw new NothingChanged("refusing to create a Twilio API key: checkAccount hasn't passed");
    const admin = await this.#adminKey();
    if ("facts" in admin) throw new NothingChanged(`${admin.reason}: ${admin.fix}`);
    const form: Record<string, string> = {
      AccountSid: target.account,
      FriendlyName: friendly(name),
      ...(target.policy === null
        ? {}
        : { KeyType: "restricted", Policy: JSON.stringify({ allow: target.policy }) }),
    };
    const made = await this.#request(admin, "POST", `${IAM}/v1/Keys`, form);
    if (made.status === 401 || made.status === 403)
      throw new NothingChanged(
        `the admin credential can't create API keys in account ${target.account} (${answered(made)}): ${ADMIN_FIX}`,
      );
    if (made.status !== 201 && made.status !== 200)
      throw failure(
        "POST",
        "/v1/Keys",
        made,
        made.status >= 400 && made.status < 500 ? NothingChanged : Error,
      );
    const { sid, secret } = made.body;
    if (typeof sid !== "string" || !KEY_SID.test(sid) || typeof secret !== "string" || !secret)
      throw new Error("Twilio's POST /v1/Keys response has no sid and secret");
    return { id: sid, secret: new Secret(secret) };
  }

  lostCreate(name: string): string {
    return `Twilio may have made the key before the reply was lost. Only this run uses the name "${friendly(name)}": delete the API key with that name${this.#target ? ` in account ${this.#target.account}` : ""} at ${DASHBOARD} before you run this again, or the rerun leaves it live.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#target)
      throw new Error("refusing to delete a Twilio API key: checkAccount hasn't passed");
    if (!KEY_SID.test(id)) return "already gone";
    const admin = await this.#adminKey();
    if ("facts" in admin) throw new Error(`${admin.reason}: ${admin.fix}`);
    const deleted = await this.#request(admin, "DELETE", `${IAM}/v1/Keys/${id}`);
    if (deleted.status === 204 || deleted.status === 200) return "revoked";
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403)
      throw new Error(
        `the admin credential can't delete API key ${id} (${answered(deleted)}): delete it at ${DASHBOARD}`,
      );
    throw failure("DELETE", "/v1/Keys/<sid>", deleted);
  }

  async #request(
    who: Admin,
    method: string,
    url: string,
    form?: Record<string, string>,
  ): Promise<Reply> {
    const response = await this.#fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`${who.user}:${who.password}`)}`,
        "User-Agent": "keypin",
        ...(form === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
    });
    const body = parseObject(await response.text());
    const code = typeof body.code === "number" ? body.code : null;
    return { status: response.status, code, body };
  }

  #adminKey(): Promise<Admin | Refusal> {
    this.#credentials ??= this.#admin().then(adminCredentials);
    return this.#credentials;
  }
}

function refusesId(id: string | null): Refusal | null {
  if (id === null)
    return {
      facts: "keypin doesn't know the vault key's API key SID",
      reason: "Twilio needs the API key SID with its secret",
      fix: "name the key that holds the API key SID with key_id in the issuer table",
    };
  if (ACCOUNT_SID.test(id))
    return {
      facts: `the key named by key_id holds Account SID ${id}`,
      reason: "keypin rotates Twilio API keys (SK…), not the account's auth token",
      fix: `make an API key for the app at ${DASHBOARD}, put its SID and secret in the vault, then run this again`,
    };
  if (!KEY_SID.test(id))
    return {
      facts: "the vault's key ID isn't a Twilio API key SID",
      reason: "an API key SID starts with SK and has 34 characters",
      fix: "put the API key SID in the key named by key_id",
    };
  return null;
}

function adminRefused(admin: Admin, reply: Reply): IssuerCheck {
  const facts = `Twilio answered ${answered(reply)} to the admin ${admin.key === null ? `auth token of account ${admin.account}` : `key ${admin.key}`}`;
  if (reply.status !== 401 && reply.status !== 403) throw failure("GET", "/v1/Keys/<sid>", reply);
  if (admin.key === null)
    return {
      ok: false,
      facts,
      reason: "Twilio doesn't accept the auth token for that Account SID",
      fix: ADMIN_FIX,
    };
  return {
    ok: false,
    facts,
    reason:
      reply.code === NOT_AUTHORIZED
        ? "the admin key is a Restricted key without permission to read API keys, or it's from another account"
        : "the admin key is a Standard key, which can't manage API keys, or its secret is wrong, or it was deleted, or it's from another account",
    fix: ADMIN_FIX,
  };
}

function policyOf(body: Record<string, unknown>): string[] | null {
  const policy = body.policy;
  if (!isRecord(policy) || !Array.isArray(policy.allow)) return null;
  return policy.allow.filter((p): p is string => typeof p === "string");
}

function friendly(name: string): string {
  return name.length > NAME_LIMIT ? name.slice(-NAME_LIMIT).trimStart() : name;
}

function answered(reply: Reply): string {
  return `HTTP ${reply.status}${reply.code === null ? "" : `, code ${reply.code}`}`;
}

function failure(
  method: string,
  path: string,
  reply: Reply,
  type: new (message: string) => Error = Error,
): Error {
  return new type(`Twilio ${method} ${path} returned ${answered(reply)}`);
}
