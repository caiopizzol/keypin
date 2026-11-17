import {
  type Fetch,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  NothingChanged,
  Secret,
} from "@keypin/core";
import {
  ACCESS_KEY_ID,
  ADMIN_FIX,
  adminCredentials,
  type Refusal,
  TEMPORARY_KEY_ID,
} from "./admin";
import { members, query, type Reply, returned, type Service, text } from "./api";
import type { Credentials } from "./sigv4";

const USERS = "https://console.aws.amazon.com/iam/home#/users";
const POLL_MS = 2000;
const POLLS = 30;
const ARN = /^arn:aws[a-z-]*:(?:iam|sts)::(\d{12}):(?:user\/(?:[^/]+\/)*([^/]+)$)?/;

export interface AwsIssuerOptions {
  admin: () => Promise<Secret>;
  fetch?: Fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface Caller {
  account: string;
  arn: string;
  user: string | null;
}

interface Listed {
  id: string;
  status: string;
  created: string;
}

interface Target {
  user: string;
  current: string;
  others: Listed[];
}

function full({ user, current, others }: Target): string {
  const other = others[0]?.id ?? "<ID>";
  return `IAM user ${user} already has two access keys, ${current} and ${others[0] ? shownKey(others[0]) : "another"}, the most AWS allows. If nothing uses ${other}, delete it with aws iam delete-access-key --user-name ${user} --access-key-id ${other}, then run this again`;
}

export class AwsIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  #credentials: Promise<Credentials | Refusal> | undefined;
  #target: Target | null = null;

  constructor(options: AwsIssuerOptions) {
    this.#admin = options.admin;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  describe(): string {
    return "AWS IAM";
  }

  dashboard(): string {
    const user = this.#target?.user;
    return user === undefined
      ? USERS
      : `${USERS}/details/${encodeURIComponent(user)}?section=security_credentials`;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#target = null;
    const admin = await this.#adminKey();
    if ("facts" in admin) return { ok: false, ...admin };
    const refused = refusesId(currentId);
    if (refused) return { ok: false, ...refused };
    const id = currentId ?? "";
    if (id === admin.id)
      return {
        ok: false,
        facts: `the admin item holds access key ${id}, the key keypin would rotate`,
        reason: "deleting the old key would leave the admin item with a key that no longer works",
        fix: `give keypin a separate admin key, of its own IAM user; ${ADMIN_FIX}`,
      };

    const key = await this.#caller({ id, secret: current.reveal() });
    if ("refused" in key) return { ok: false, ...vaultRefused(id, key.refused) };
    const signer = await this.#caller(admin);
    if ("refused" in signer) return { ok: false, ...adminRefused(admin.id, signer.refused) };
    const facts = `the vault holds access key ${id} of ${who(key)}`;
    if (key.user === null)
      return {
        ok: false,
        facts,
        reason: key.arn.endsWith(":root")
          ? "it's the account's root user key; keypin rotates IAM users' keys, and AWS advises against root keys"
          : "keypin rotates the access keys of IAM users",
        fix: `create an IAM user for the app at ${USERS}, give it a key, and put that in the vault`,
      };
    if (signer.user === null)
      return {
        ok: false,
        facts: `the admin item holds a key of ${who(signer)}`,
        reason: "keypin signs in to AWS with an IAM user's key, not the root user's",
        fix: ADMIN_FIX,
      };
    if (signer.account !== key.account)
      return {
        ok: false,
        facts: `${facts}; the admin key is from account ${signer.account}`,
        reason: `the admin key manages account ${signer.account}, and the vault's key is in account ${key.account}`,
        fix: `use an admin key from account ${key.account}; ${ADMIN_FIX}`,
      };
    if (signer.arn === key.arn)
      return {
        ok: false,
        facts: `${facts}; the admin key ${admin.id} is the same user's`,
        reason: `an IAM user has at most two access keys, and the admin key takes ${key.user}'s second one, so there's no room for the new key`,
        fix: `give the admin key its own IAM user; ${ADMIN_FIX}`,
      };

    const list = await this.#iam("ListAccessKeys", { UserName: key.user });
    if (list.status === 403)
      return {
        ok: false,
        facts,
        reason: `the admin key can't list the access keys of IAM user ${key.user} (${returned("ListAccessKeys", list)})`,
        fix: ADMIN_FIX,
      };
    if (list.status !== 200) throw new Error(returned("ListAccessKeys", list));
    const listed = members(list.xml).map(parseListed);
    if (!listed.some((k) => k.id === id))
      return {
        ok: false,
        facts,
        reason: `AWS doesn't list access key ${id} for IAM user ${key.user} yet`,
        fix: "wait a minute, then run this again",
      };
    const others = listed.filter((k) => k.id !== id);
    this.#target = { user: key.user, current: id, others };
    return {
      ok: true,
      facts,
      currentId: id,
      notes: {
        create: others.length
          ? `for IAM user ${key.user}, who also has ${others.map(shownKey).join(" and ")}; AWS allows two keys per user`
          : `for IAM user ${key.user}`,
        revoke: "keypin deactivates it, then deletes it",
      },
    };
  }

  async create(): Promise<IssuedKey> {
    const target = this.#target;
    if (!target)
      throw new NothingChanged("refusing to create an AWS access key: checkAccount hasn't passed");
    if (target.others.length) throw new NothingChanged(full(target));
    const made = await this.#iam("CreateAccessKey", { UserName: target.user });
    if (made.code === "LimitExceeded") throw new NothingChanged(full(target));
    if (made.status === 401 || made.status === 403)
      throw new NothingChanged(
        `the admin key can't create access keys for IAM user ${target.user} (${returned("CreateAccessKey", made)}): ${ADMIN_FIX}`,
      );
    if (made.status !== 200)
      throw made.status >= 400 && made.status < 500
        ? new NothingChanged(returned("CreateAccessKey", made))
        : new Error(returned("CreateAccessKey", made));
    const id = text(made.xml, "AccessKeyId");
    const secret = text(made.xml, "SecretAccessKey");
    if (id === null || !ACCESS_KEY_ID.test(id) || !secret)
      throw new Error("AWS's CreateAccessKey reply has no access key");
    if (await this.#authenticates({ id, secret })) return { id, secret: new Secret(secret) };
    const waited = `AWS didn't accept the new access key ${id} within ${(POLLS * POLL_MS) / 1000} seconds`;
    try {
      await this.revoke(id);
    } catch {
      throw new Error(
        `${waited}, and keypin couldn't delete it: delete it at ${this.dashboard()}, then run this again`,
      );
    }
    throw new NothingChanged(`${waited}, so keypin deleted it. Run this again`);
  }

  lostCreate(): string {
    const target = this.#target;
    if (!target)
      return `AWS may have made an access key before the reply was lost, and IAM keys have no name to find it by. Delete it at ${USERS} before you run this again.`;
    return `AWS may have made an access key for IAM user ${target.user} before the reply was lost, and IAM keys have no name to find it by. Run aws iam list-access-keys --user-name ${target.user}: keep ${target.current}, the vault's key, and delete the other one with aws iam delete-access-key --user-name ${target.user} --access-key-id <ID> before you run this again. Until then the user has no room for a new key.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    const target = this.#target;
    if (!target)
      throw new Error("refusing to delete an AWS access key: checkAccount hasn't passed");
    if (!ACCESS_KEY_ID.test(id)) return "already gone";
    const key = { UserName: target.user, AccessKeyId: id };
    const off = await this.#iam("UpdateAccessKey", { ...key, Status: "Inactive" });
    if (off.code === "NoSuchEntity") {
      target.others = target.others.filter((k) => k.id !== id);
      return "already gone";
    }
    if (off.status === 401 || off.status === 403)
      throw new Error(
        `the admin key can't deactivate access key ${id} of IAM user ${target.user} (${returned("UpdateAccessKey", off)}): ${ADMIN_FIX}, or delete the key at ${this.dashboard()}`,
      );
    if (off.status !== 200) throw new Error(returned("UpdateAccessKey", off));
    const deleted = await this.#iam("DeleteAccessKey", key);
    if (deleted.status === 200 || deleted.code === "NoSuchEntity") {
      target.others = target.others.filter((k) => k.id !== id);
      return "revoked";
    }
    throw new Error(
      `keypin deactivated access key ${id}, so it no longer works, but couldn't delete it (${returned("DeleteAccessKey", deleted)}): delete it at ${this.dashboard()}`,
    );
  }

  async #authenticates(credentials: Credentials): Promise<boolean> {
    for (let poll = 0; poll < POLLS; poll++) {
      if (poll) await this.#sleep(POLL_MS);
      const caller = await this.#caller(credentials).catch(() => null);
      if (caller !== null && !("refused" in caller)) return true;
    }
    return false;
  }

  async #caller(credentials: Credentials): Promise<Caller | { refused: Reply }> {
    const reply = await this.#query("sts", credentials, "GetCallerIdentity", {});
    if (reply.status !== 200) {
      if (reply.status === 403) return { refused: reply };
      throw new Error(returned("GetCallerIdentity", reply));
    }
    const arn = text(reply.xml, "Arn") ?? "";
    const parsed = ARN.exec(arn);
    if (!parsed) throw new Error("AWS's GetCallerIdentity reply has no ARN keypin can read");
    return { account: parsed[1] ?? "", arn, user: parsed[2] ?? null };
  }

  async #iam(action: string, params: Record<string, string>): Promise<Reply> {
    const admin = await this.#adminKey();
    if ("facts" in admin) throw new Error(`${admin.reason}: ${admin.fix}`);
    return this.#query("iam", admin, action, params);
  }

  #query(
    service: Service,
    credentials: Credentials,
    action: string,
    params: Record<string, string>,
  ): Promise<Reply> {
    return query(this.#fetch, service, credentials, action, params, this.#now());
  }

  #adminKey(): Promise<Credentials | Refusal> {
    this.#credentials ??= this.#admin().then(adminCredentials);
    return this.#credentials;
  }
}

function refusesId(id: string | null): Refusal | null {
  const fix =
    "put the access key ID, AKIA followed by 16 letters and digits, in the key named by key_id";
  if (id === null)
    return {
      facts: "keypin doesn't know the vault key's access key ID",
      reason: "AWS needs the access key ID with its secret",
      fix: "name the key that holds the access key ID with key_id in the issuer table",
    };
  if (TEMPORARY_KEY_ID.test(id))
    return {
      facts: `the vault holds temporary credentials ${id}`,
      reason:
        "temporary credentials expire on their own, and keypin rotates IAM users' long-term keys",
      fix,
    };
  if (!ACCESS_KEY_ID.test(id))
    return {
      facts: "the vault's key ID isn't an AWS access key ID",
      reason: "an IAM user's access key ID starts with AKIA and has 20 characters",
      fix,
    };
  return null;
}

function vaultRefused(id: string, reply: Reply): Refusal {
  const facts = `AWS answered HTTP ${reply.status}${reply.code ? ` ${reply.code}` : ""}`;
  if (reply.code === "SignatureDoesNotMatch")
    return {
      facts,
      reason: `the vault's secret isn't the secret of access key ${id}, or this computer's clock is off`,
      fix: "put the secret access key and its ID, from the same key, in the vault",
    };
  return {
    facts,
    reason: `AWS doesn't accept access key ${id}: it was deleted or deactivated, or it isn't an access key`,
    fix: `put a working access key and its secret in the vault; if the key was deleted, create one at ${USERS}`,
  };
}

function adminRefused(id: string, reply: Reply): Refusal {
  const facts = `AWS answered HTTP ${reply.status}${reply.code ? ` ${reply.code}` : ""} for the admin key ${id}`;
  return {
    facts,
    reason:
      reply.code === "SignatureDoesNotMatch"
        ? "the admin item's SecretAccessKey isn't its AccessKeyId's secret, or this computer's clock is off"
        : "AWS doesn't accept the admin key: it was deleted or deactivated",
    fix: ADMIN_FIX,
  };
}

function who(caller: Caller): string {
  if (caller.user !== null) return `IAM user ${caller.user} in account ${caller.account}`;
  return caller.arn.endsWith(":root")
    ? `the root user of account ${caller.account}`
    : `${caller.arn} in account ${caller.account}`;
}

function parseListed(xml: string): Listed {
  return {
    id: text(xml, "AccessKeyId") ?? "",
    status: text(xml, "Status") ?? "",
    created: text(xml, "CreateDate") ?? "",
  };
}

function shownKey(key: Listed): string {
  const day = key.created.slice(0, 10);
  return `key ${key.id}${key.status === "Inactive" ? " (inactive)" : ""}${day ? `, created ${day}` : ""}`;
}
