import {
  type Fetch,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  isRecord,
  Secret,
} from "@keypin/core";

const API = "https://console.neon.tech/api/v2";
const KEYS_DOCS = "https://neon.com/docs/manage/api-keys";
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

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

interface Operation {
  id: string;
  action: string;
  status: string;
}

export class NeonIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #projectId: string;
  readonly #branchId: string;
  readonly #database: string;
  readonly #roles: readonly [string, string];
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  #key: Promise<Secret> | undefined;
  #passed = false;
  #idle = "";
  #vaultUser: string | null = null;
  #pooled = false;
  #query = "";

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
    const project = await this.#request("GET", this.#inProject(""));
    if (project.status !== 200) return this.#refused(project);
    const listed = await this.#request("GET", this.#onBranch("/roles"));
    if (listed.status === 404)
      return {
        ok: false,
        facts: `the admin key reaches project ${this.#projectId}`,
        reason: `Neon project ${this.#projectId} has no branch ${this.#branchId}`,
        fix: "check branch_id in keypin.toml",
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
          ? [`create ${missing.join(" and ")} with SQL, with the same grants as the other role`]
          : []),
        ...(database.status === 404 ? ["check database in keypin.toml"] : []),
      ];
      return {
        ok: false,
        facts: `branch ${this.#branchId} has ${passwords.size} role${passwords.size === 1 ? "" : "s"}`,
        reason: `Neon branch ${this.#branchId} has no ${gaps.join(" and no ")}`,
        fix: fixes.join("; "),
      };
    }
    const facts = `roles ${a} and ${b}, database ${this.#database}`;
    const user = userOf(current);
    const known = currentId === null ? null : parseId(currentId);
    const live = currentId === null ? user : (known?.role ?? null);
    const at = live !== null && this.#roles.includes(live) ? passwords.get(live) : undefined;
    if (currentId !== null && (!known || at === undefined))
      return {
        ok: false,
        facts,
        reason: `key ${currentId}, the one keypin issued last time, isn't a password of role ${a} or ${b}`,
      };
    if (known && at !== known.at)
      return {
        ok: false,
        facts,
        reason: `role ${known.role}'s password changed at ${at}, after keypin set it, so the vault's URL may not work`,
        fix: `if someone reset it, put ${known.role}'s new connection string in the vault, then run this again`,
      };
    const idle = live === a ? b : a;
    this.#idle = idle;
    this.#vaultUser = user;
    const vaultUrl = parseUrl(current.reveal());
    this.#pooled = vaultUrl?.hostname.split(".")[0]?.endsWith("-pooler") ?? false;
    this.#query = vaultUrl?.search ?? "";
    this.#passed = true;
    if (live === null || at === undefined)
      return { ok: true, facts, notes: { create: `resets the password of role ${idle}` } };
    return {
      ok: true,
      facts: `${facts}; the vault uses ${live}`,
      ...(currentId === null ? { currentId: `${live}@${at}` } : {}),
      notes: {
        create: `resets the password of role ${idle}, which the vault's URL doesn't use`,
        revoke: `resets the password of role ${live}, which drops its open connections`,
      },
    };
  }

  async create(): Promise<IssuedKey> {
    if (!this.#passed)
      throw new Error("refusing to reset a Neon password: checkAccount hasn't passed");
    const role = this.#idle;
    if (role === this.#vaultUser)
      throw new Error(
        `keypin won't reset Neon role ${role}: the URL in the vault uses it, and keypin set the other role's password last. Put the URL your apps use in the vault, then run this again`,
      );
    const url = await this.#connectionUri(role);
    url.username = role;
    if (this.#query) url.search = this.#query;
    url.password = await this.#reset(role);
    const at = await this.#passwordTime(role);
    if (at === null) throw new Error(`Neon role ${role} is gone after its password reset`);
    return { id: `${role}@${at}`, secret: new Secret(url.toString()) };
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#passed)
      throw new Error("refusing to reset a Neon password: checkAccount hasn't passed");
    const issued = parseId(id);
    const role = issued?.role ?? id;
    const at = await this.#passwordTime(role);
    if (at === null) return "already gone";
    if (!issued || !this.#roles.includes(role))
      throw new Error(
        `keypin won't reset Neon role ${role}: key ${id} isn't a password keypin set on role ${this.#roles.join(" or ")}`,
      );
    if (at !== issued.at) return "already gone";
    await this.#reset(role);
    return "revoked";
  }

  async #reset(role: string): Promise<string> {
    const path = this.#onBranch(`/roles/${encodeURIComponent(role)}/reset_password`);
    let reply = await this.#request("POST", path);
    for (let tries = 1; reply.status === 423 && tries < LOCKED_TRIES; tries++) {
      await this.#sleep(wait(tries));
      reply = await this.#request("POST", path);
    }
    if (reply.status !== 200) throw failure("POST", `/roles/${role}/reset_password`, reply);
    const password = isRecord(reply.body.role) ? reply.body.role.password : undefined;
    if (typeof password !== "string" || !password)
      throw new Error(`Neon's reset_password response for role ${role} has no password`);
    for (const operation of operationsOf(reply.body)) await this.#finish(role, operation);
    return password;
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

  async #connectionUri(role: string): Promise<URL> {
    const query = new URLSearchParams({
      branch_id: this.#branchId,
      database_name: this.#database,
      role_name: role,
      ...(this.#pooled ? { pooled: "true" } : {}),
    });
    const reply = await this.#request("GET", this.#inProject(`/connection_uri?${query}`));
    if (reply.status !== 200) throw failure("GET", "/connection_uri", reply);
    const url = parseUrl(reply.body.uri);
    if (!url) throw new Error("Neon's connection_uri response has no postgresql:// URI");
    return url;
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
        fix: `check project_id in keypin.toml, or use a key that reaches the project; see ${KEYS_DOCS}`,
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

function passwordTimes(body: Record<string, unknown>): Map<string, string> {
  const roles = Array.isArray(body.roles) ? body.roles : [];
  return new Map(
    roles.flatMap((role: unknown) =>
      isRecord(role) && typeof role.name === "string" && typeof role.updated_at === "string"
        ? [[role.name, role.updated_at] as const]
        : [],
    ),
  );
}

function operationsOf(body: Record<string, unknown>): Operation[] {
  const operations = Array.isArray(body.operations) ? body.operations : [];
  return operations.flatMap((operation: unknown) =>
    isRecord(operation) && typeof operation.id === "string" && typeof operation.status === "string"
      ? [
          {
            id: operation.id,
            status: operation.status,
            action: typeof operation.action === "string" ? operation.action : "unknown",
          },
        ]
      : [],
  );
}

function parseUrl(text: unknown): URL | null {
  if (typeof text !== "string") return null;
  try {
    const url = new URL(text);
    return url.protocol === "postgresql:" || url.protocol === "postgres:" ? url : null;
  } catch {
    return null;
  }
}

function userOf(current: Secret): string | null {
  const url = parseUrl(current.reveal());
  if (!url?.username) return null;
  try {
    return decodeURIComponent(url.username);
  } catch {
    return null;
  }
}

function failure(method: string, path: string, reply: Reply): Error {
  return new Error(`Neon ${method} ${path} returned HTTP ${reply.status}${codeOf(reply)}`);
}

function codeOf(reply: Reply): string {
  const code = reply.body.code;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? ` ${code}` : "";
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}
