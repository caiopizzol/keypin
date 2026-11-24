import {
  type Fetch,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  isRecord,
  NothingChanged,
  parseObject,
  RevokeRefused,
  Secret,
} from "@keypin/core";
import {
  codeOf,
  endpointIds,
  failure,
  type Operation,
  operationsOf,
  passwordTimes,
  type Reply,
} from "./replies";
import { databaseOf, endpointOf, parseUrl, userOf } from "./url";

const API = "https://console.neon.tech/api/v2";
const KEYS_DOCS = "https://neon.com/docs/manage/api-keys";
const PERMISSIONS_DOCS = "https://neon.com/docs/manage/user-permissions";
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 5000;
const POLLS = 60;
const LOCKED_TRIES = 5;
const DONE = ["finished", "skipped"];
const FAILED = ["failed", "error", "cancelled"];

export interface NeonIssuerOptions {
  admin: () => Promise<Secret>;
  projectId: string;
  branchId: string;
  database: string;
  roles: readonly [string, string];
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class NeonIssuer implements Issuer {
  readonly createResetsOld = true;
  readonly #admin: () => Promise<Secret>;
  readonly #projectId: string;
  readonly #branchId: string;
  readonly #database: string;
  readonly #roles: readonly [string, string];
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  #key: Promise<Secret> | undefined;
  #passed = false;
  #idle: { role: string; at: string } | null = null;
  #vault: URL | null = null;
  #vaultUser = "";

  constructor(options: NeonIssuerOptions) {
    this.#admin = options.admin;
    this.#projectId = options.projectId;
    this.#branchId = options.branchId;
    this.#database = options.database;
    this.#roles = options.roles;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  describe(): string {
    return "Neon";
  }

  dashboard(): string {
    return `https://console.neon.tech/app/projects/${encodeURIComponent(this.#projectId)}`;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#passed = false;
    this.#idle = null;
    this.#vault = null;
    const project = await this.#request("GET", this.#inProject(""));
    if (project.status !== 200) return this.#refused(project);
    const access = isRecord(project.body.project)
      ? project.body.project.effective_project_permission
      : undefined;
    if (access === "VIEWER")
      return {
        ok: false,
        facts: `the admin key has Viewer access to project ${this.#projectId}`,
        reason: `the admin key can read Neon project ${this.#projectId} but can't reset passwords in it`,
        fix: `use an API key with Editor or Admin access to the project; see ${PERMISSIONS_DOCS}`,
      };
    const listed = await this.#request("GET", this.#onBranch("/roles"));
    if (listed.status === 404)
      return {
        ok: false,
        facts: `the admin key reaches project ${this.#projectId}`,
        reason: `Neon project ${this.#projectId} has no branch ${this.#branchId}`,
        fix: "check branch_id in secretspec.toml",
      };
    if (listed.status !== 200) throw failure("GET", "/roles", listed);
    const passwords = passwordTimes(listed.body);
    const database = await this.#request(
      "GET",
      this.#onBranch(`/databases/${encodeURIComponent(this.#database)}`),
    );
    if (database.status !== 200 && database.status !== 404)
      throw failure("GET", "/databases/<database>", database);

    const [a, b] = this.#roles;
    const missing = this.#roles.filter((role) => !passwords.has(role));
    if (missing.length || database.status === 404) {
      const gaps = [
        ...missing.map((role) => `role ${role}`),
        ...(database.status === 404 ? [`database ${this.#database}`] : []),
      ];
      const fixes = [
        ...(missing.length
          ? [
              `create ${missing.join(" and ")} with SQL, in the same group role as the other (see docs/guides/rotating-a-key.md#neon)`,
            ]
          : []),
        ...(database.status === 404 ? ["check database in secretspec.toml"] : []),
      ];
      return {
        ok: false,
        facts: `branch ${this.#branchId} has ${passwords.size} role${passwords.size === 1 ? "" : "s"}`,
        reason: `Neon branch ${this.#branchId} has no ${gaps.join(" and no ")}`,
        fix: fixes.join("; "),
      };
    }
    const facts = `roles ${a} and ${b}, database ${this.#database}`;
    const vault = parseUrl(current.reveal());
    const user = userOf(vault);
    const fix = `put the URL your apps use, for role ${a} or ${b}, in the vault, then run this again`;
    if (!vault || user === null || !this.#roles.includes(user))
      return {
        ok: false,
        facts,
        reason: vault
          ? `the vault's URL uses ${user === null ? "no role" : `role ${user}`}, not ${a} or ${b}`
          : "the vault's value isn't a postgresql:// URL",
        fix,
      };
    if (databaseOf(vault) !== this.#database)
      return {
        ok: false,
        facts,
        reason: `the vault's URL connects to database ${databaseOf(vault) || "(none)"}, not ${this.#database}`,
        fix,
      };
    const endpoint = endpointOf(vault);
    const endpoints = await this.#request("GET", this.#onBranch("/endpoints"));
    if (endpoints.status !== 200) throw failure("GET", "/endpoints", endpoints);
    if (!endpointIds(endpoints.body).has(endpoint))
      return {
        ok: false,
        facts,
        reason: `the vault's URL connects to ${endpoint}, which isn't a compute of Neon branch ${this.#branchId}`,
        fix: "check branch_id in secretspec.toml, or put the branch's URL in the vault",
      };
    const known = currentId === null ? null : parseId(currentId);
    if (currentId !== null && (!known || !this.#roles.includes(known.role)))
      return {
        ok: false,
        facts,
        reason: `key ${currentId}, the one keypin issued last time, isn't a password of role ${a} or ${b}`,
      };
    const role = known?.role ?? user;
    const at = passwords.get(role);
    if (known && at !== known.at)
      return {
        ok: false,
        facts,
        reason: `role ${known.role}'s password changed at ${at}, after keypin set it, so the vault's URL may not work`,
        fix: `if someone reset it, put ${known.role}'s new connection string in the vault, then run this again`,
      };
    this.#vault = vault;
    this.#vaultUser = user;
    this.#passed = true;
    const heldInVault = role !== user;
    if (heldInVault)
      return { ok: true, facts: `${facts}; the vault uses ${user}, keypin set ${role} last` };
    const idle = user === a ? b : a;
    this.#idle = { role: idle, at: passwords.get(idle) ?? "" };
    return {
      ok: true,
      facts: `${facts}; the vault uses ${user}`,
      ...(currentId === null ? { currentId: `${user}@${at}` } : {}),
      notes: {
        create: `resets the password of role ${idle}, which the vault's URL doesn't use; every open connection drops`,
        revoke: `resets the password of role ${user}: every connection string that uses ${user} stops working, and every open connection drops`,
      },
    };
  }

  async create(): Promise<IssuedKey> {
    if (!this.#passed || !this.#vault)
      throw new NothingChanged("refusing to reset a Neon password: checkAccount hasn't passed");
    if (!this.#idle)
      throw new NothingChanged(
        `keypin won't reset Neon role ${this.#vaultUser}: the URL in the vault uses it, and keypin set the other role's password last. Put the URL your apps use in the vault, then run this again`,
      );
    const { role, at: checked } = this.#idle;
    const again = "so another rotation may be running. Run rotate again";
    const before = await this.#passwordTime(role);
    if (before === null) throw new NothingChanged(`Neon role ${role} is gone`);
    if (before !== checked)
      throw new NothingChanged(
        `Neon role ${role}'s password changed at ${before}, after keypin checked it, ${again}`,
      );
    const reset = await this.#reset(role);
    const at = await this.#passwordTime(role);
    if (at === null) throw new Error(`Neon role ${role} is gone after its password reset`);
    if (at !== reset.at)
      throw new Error(
        `Neon role ${role}'s password changed again at ${at}, during keypin's reset, ${again}`,
      );
    const url = new URL(this.#vault.href);
    url.username = role;
    url.password = reset.password;
    return { id: `${role}@${at}`, secret: new Secret(url.toString()) };
  }

  lostCreate(): string {
    return `Neon may have reset the password of role ${this.#idle?.role ?? "the idle role"} before the reply was lost. Nothing uses that role yet, so running this again is safe.`;
  }

  async has(id: string): Promise<boolean> {
    const issued = parseId(id);
    if (!issued || !this.#roles.includes(issued.role)) return false;
    return (await this.#passwordTime(issued.role)) === issued.at;
  }

  async revoke(id: string, current: Secret): Promise<"revoked" | "already gone"> {
    if (!this.#passed)
      throw new Error("refusing to reset a Neon password: checkAccount hasn't passed");
    const issued = parseId(id);
    const role = issued?.role ?? id;
    const at = await this.#passwordTime(role);
    if (at === null) return "already gone";
    if (!issued || !this.#roles.includes(role))
      throw new RevokeRefused(`it isn't a password keypin set on role ${this.#roles.join(" or ")}`);
    const user = userOf(parseUrl(current.reveal()));
    if (user === null) throw new RevokeRefused("keypin can't tell which role the vault's URL uses");
    if (role === user)
      throw new RevokeRefused(`it's the password of role ${role}, which the vault's URL uses`);
    if (at !== issued.at) return "already gone";
    await this.#reset(role);
    return "revoked";
  }

  async #reset(role: string): Promise<{ password: string; at: string }> {
    const path = this.#onBranch(`/roles/${encodeURIComponent(role)}/reset_password`);
    let reply = await this.#request("POST", path);
    for (let tries = 1; reply.status === 423 && tries < LOCKED_TRIES; tries++) {
      await this.#sleep(wait(tries));
      reply = await this.#request("POST", path);
    }
    if (reply.status === 403 || reply.status === 404) {
      if ((await this.#passwordTime(role)) === null)
        throw new NothingChanged(`Neon role ${role} is gone from branch ${this.#branchId}`);
      throw new NothingChanged(
        `Neon refused to reset role ${role}'s password (HTTP ${reply.status}${codeOf(reply)}): the admin key can read project ${this.#projectId} but may not change it. Use an API key with Editor or Admin access to the project; see ${PERMISSIONS_DOCS}`,
      );
    }
    if (reply.status !== 200)
      throw failure(
        "POST",
        `/roles/${role}/reset_password`,
        reply,
        reply.status >= 400 && reply.status < 500 ? NothingChanged : Error,
      );
    const reset = isRecord(reply.body.role) ? reply.body.role : {};
    const { password, updated_at: at } = reset;
    if (typeof password !== "string" || !password)
      throw new Error(`Neon's reset_password response for role ${role} has no password`);
    if (typeof at !== "string" || !at)
      throw new Error(`Neon's reset_password response for role ${role} has no updated_at`);
    for (const operation of operationsOf(reply.body)) await this.#finish(role, operation);
    return { password, at };
  }

  async #finish(role: string, operation: Operation): Promise<void> {
    let { status } = operation;
    for (let polls = 0; !DONE.includes(status); polls++) {
      if (FAILED.includes(status))
        throw new Error(
          `Neon's password reset for role ${role} ended ${status} (operation ${operation.action} ${operation.id})`,
        );
      if (polls === POLLS)
        throw new Error(
          `Neon's password reset for role ${role} is still ${status} after ${POLLS} checks (operation ${operation.id})`,
        );
      await this.#sleep(wait(polls));
      const reply = await this.#request(
        "GET",
        this.#inProject(`/operations/${encodeURIComponent(operation.id)}`),
      );
      if (reply.status !== 200) throw failure("GET", "/operations/<id>", reply);
      const polled = isRecord(reply.body.operation) ? reply.body.operation.status : undefined;
      status = typeof polled === "string" ? polled : "unknown";
    }
  }

  async #passwordTime(role: string): Promise<string | null> {
    const reply = await this.#request("GET", this.#onBranch(`/roles/${encodeURIComponent(role)}`));
    if (reply.status === 404) return null;
    if (reply.status !== 200) throw failure("GET", "/roles/<role>", reply);
    const at = isRecord(reply.body.role) ? reply.body.role.updated_at : undefined;
    if (typeof at !== "string" || !at)
      throw new Error(`Neon's response for role ${role} has no updated_at`);
    return at;
  }

  #refused(reply: Reply): IssuerCheck {
    const facts = `Neon answered HTTP ${reply.status}${codeOf(reply)}`;
    if (reply.status === 401)
      return {
        ok: false,
        facts,
        reason:
          "Neon doesn't accept the admin key: it was revoked, or the item holds another value",
        fix: `put a Neon API key in the admin item; see ${KEYS_DOCS}`,
      };
    if (reply.status === 403 || reply.status === 404)
      return {
        ok: false,
        facts,
        reason: `the admin key can't reach Neon project ${this.#projectId}: the ID is wrong, or the key belongs to another organization or project`,
        fix: `check project_id in secretspec.toml, or use a key that reaches the project; see ${KEYS_DOCS}`,
      };
    throw failure("GET", "/projects/<project_id>", reply);
  }

  #inProject(path: string): string {
    return `/projects/${encodeURIComponent(this.#projectId)}${path}`;
  }

  #onBranch(path: string): string {
    return this.#inProject(`/branches/${encodeURIComponent(this.#branchId)}${path}`);
  }

  async #request(method: string, path: string): Promise<Reply> {
    this.#key ??= this.#admin();
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${(await this.#key).reveal()}`,
        Accept: "application/json",
        "User-Agent": "keypin",
      },
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

function wait(attempt: number): number {
  return Math.min(FIRST_WAIT_MS * 2 ** attempt, LONGEST_WAIT_MS);
}

function parseId(id: string): { role: string; at: string } | null {
  const split = id.lastIndexOf("@");
  if (split <= 0 || split === id.length - 1) return null;
  return { role: id.slice(0, split), at: id.slice(split + 1) };
}
