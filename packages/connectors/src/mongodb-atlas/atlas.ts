import { randomBytes } from "node:crypto";
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
import { hostsOf, type MongoUri, parseUri, withUser } from "./uri";

const CLOUD = "https://cloud.mongodb.com";
const API = `${CLOUD}/api/atlas/v2`;
const TOKEN_URL = `${CLOUD}/api/oauth/token`;
const VERSIONS = {
  user: "2023-01-01",
  project: "2023-01-01",
  status: "2023-01-01",
  clusters: "2024-08-05",
  flex: "2024-11-13",
} as const;
const SERVICE_ACCOUNTS = "https://www.mongodb.com/docs/atlas/configure-api-access/";
const ADMIN_FIX = `put the client secret (mdb_sa_sk_…) of an Atlas service account with the Project Database Access Admin role in the admin item, and its client ID in client_id; see ${SERVICE_ACCOUNTS}`;
const EXTERNAL = ["MONGODB-X509", "MONGODB-AWS", "MONGODB-OIDC", "PLAIN", "GSSAPI"];
const AUTH_TYPES = ["x509Type", "awsIAMType", "ldapAuthType", "oidcAuthType"] as const;
const EARLY_MS = 60_000;
const FIRST_WAIT_MS = 1000;
const LONGEST_WAIT_MS = 5000;
const POLLS = 60;

export interface AtlasIssuerOptions {
  admin: () => Promise<Secret>;
  clientId: string;
  projectId: string;
  fetch?: Fetch;
  password?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

interface Copy {
  source: string;
  target: string;
  uri: MongoUri;
  cluster: { name: string; flex: boolean };
  user: Record<string, unknown>;
}

type Refusal = Extract<IssuerCheck, { ok: false }>;

export class AtlasIssuer implements Issuer {
  readonly #admin: () => Promise<Secret>;
  readonly #clientId: string;
  readonly #projectId: string;
  readonly #password: () => string;
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #token: { value: string; until: number } | null = null;
  #copy: Copy | null = null;

  constructor(options: AtlasIssuerOptions) {
    this.#admin = options.admin;
    this.#clientId = options.clientId;
    this.#projectId = options.projectId;
    this.#password = options.password ?? (() => randomBytes(24).toString("base64url"));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#now = options.now ?? Date.now;
  }

  describe(): string {
    return "MongoDB Atlas";
  }

  dashboard(): string {
    return `${CLOUD}/v2/${encodeURIComponent(this.#projectId)}#/security/database/users`;
  }

  async checkAccount(currentId: string | null, current: Secret): Promise<IssuerCheck> {
    this.#copy = null;
    const signedIn = await this.#signIn();
    if (signedIn) return signedIn;
    const project = await this.#request("GET", this.#inProject(""), VERSIONS.project);
    if (project.status !== 200) return this.#refused(project);
    const name = typeof project.body.name === "string" ? project.body.name : this.#projectId;
    const facts = `the service account reaches project ${name}`;

    const uri = parseUri(current.reveal());
    const fix = "put the connection string your apps use in the vault, then run this again";
    if (!uri)
      return {
        ok: false,
        facts,
        reason:
          "the vault's value isn't a mongodb+srv:// or mongodb:// connection string with a username and password",
        fix,
      };
    const mechanism = uri.options.get("authMechanism")?.toUpperCase() ?? "";
    if (EXTERNAL.includes(mechanism) || uri.options.get("authSource") === "$external")
      return {
        ok: false,
        facts,
        reason: `the vault's connection string signs in with ${mechanism || "an external authSource"}, which has no password keypin can rotate`,
        fix: "keypin rotates only password (SCRAM) users",
      };
    const cluster = await this.#clusterFor(uri.hosts);
    if (!cluster)
      return {
        ok: false,
        facts,
        reason: `the vault's connection string connects to ${uri.hosts.join(",")}, which isn't a cluster in project ${name}`,
        fix: "check project_id in keypin.toml, or put a connection string for this project's cluster in the vault",
      };

    const source = currentId ?? uri.username;
    const which = currentId === null ? "the vault's user" : "the one keypin created last time";
    const found = await this.#user(source);
    if (!found)
      return {
        ok: false,
        facts,
        reason: `project ${name} has no password user ${source}, ${which}: it was deleted, or it isn't a password user`,
        fix: `check the user at ${this.dashboard()}`,
      };
    const userFacts = `${facts}; cluster ${cluster.name}, user ${source}`;
    const external = AUTH_TYPES.find((field) => (found[field] ?? "NONE") !== "NONE");
    if (external)
      return {
        ok: false,
        facts: userFacts,
        reason: `user ${source} signs in with ${String(found[external])} (${external}), which has no password keypin can rotate`,
        fix: "keypin rotates only password (SCRAM) users",
      };
    if (typeof found.deleteAfterDate === "string")
      return {
        ok: false,
        facts: userFacts,
        reason: `user ${source} is temporary: Atlas deletes it on ${found.deleteAfterDate}`,
        fix: "put the connection string of a user that doesn't expire in the vault",
      };
    const target = nextName(source);
    this.#copy = { source, target, uri, cluster, user: found };
    return {
      ok: true,
      facts: userFacts,
      ...(currentId === null ? { currentId: source } : {}),
      notes: {
        create: `creates database user ${target} with ${source}'s roles and scopes`,
        revoke: `deletes database user ${source}: every connection string that uses it stops working`,
      },
    };
  }

  async create(): Promise<IssuedKey> {
    const copy = this.#copy;
    if (!copy)
      throw new NothingChanged(
        "refusing to create an Atlas database user: checkAccount hasn't passed",
      );
    const { source, target, uri, cluster, user } = copy;
    if (await this.#user(target))
      throw new NothingChanged(
        `database user ${target}, the name keypin gives the user after ${source}, already exists. If nothing uses it, delete it at ${this.dashboard()}, then run this again`,
      );
    const password = this.#password();
    const created = await this.#request("POST", this.#inProject("/databaseUsers"), VERSIONS.user, {
      username: target,
      password,
      databaseName: "admin",
      groupId: this.#projectId,
      roles: Array.isArray(user.roles) ? user.roles : [],
      ...(Array.isArray(user.scopes) && user.scopes.length ? { scopes: user.scopes } : {}),
      ...(Array.isArray(user.labels) && user.labels.length ? { labels: user.labels } : {}),
      ...(typeof user.description === "string" && user.description
        ? { description: user.description }
        : {}),
    });
    if (created.status === 409)
      throw new NothingChanged(
        `Atlas says database user ${target} already exists, so another rotation may be running. If nothing uses it, delete it at ${this.dashboard()}, then run this again`,
      );
    if (created.status === 401 || created.status === 403)
      throw new NothingChanged(
        `Atlas refused to create database user ${target} (HTTP ${created.status}${codeOf(created)}): the project may have reached its database user limit (100 unless raised), or the service account lacks Project Database Access Admin or an API access list entry for this computer. Check at ${this.dashboard()}, then run this again`,
      );
    if (created.status !== 201 && created.status !== 200)
      throw failure(
        "POST",
        "/databaseUsers",
        created,
        created.status >= 400 && created.status < 500 ? NothingChanged : Error,
      );
    if (!cluster.flex && !(await this.#applied(cluster.name))) {
      const gone = await this.#delete(target);
      if (gone === null)
        throw new Error(
          `Atlas didn't finish adding database user ${target} to cluster ${cluster.name}, and keypin couldn't delete it: delete it at ${this.dashboard()}, then run this again`,
        );
      throw new NothingChanged(
        `Atlas didn't finish adding database user ${target} to cluster ${cluster.name} in time, so keypin deleted it. Run this again later`,
      );
    }
    return { id: target, secret: new Secret(withUser(uri, target, password)) };
  }

  lostCreate(): string {
    const target = this.#copy?.target ?? "the new database user";
    return `MongoDB Atlas may have created database user ${target} before the reply was lost. Nothing uses it yet. Delete it at ${this.dashboard()}, then run this again; keypin won't create a user that already exists.`;
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    if (!this.#copy)
      throw new Error("refusing to delete an Atlas database user: checkAccount hasn't passed");
    const deleted = await this.#delete(id);
    if (deleted === null)
      throw new Error(
        `the service account can't delete database user ${id}: delete it at ${this.dashboard()}`,
      );
    return deleted;
  }

  async #delete(username: string): Promise<"revoked" | "already gone" | null> {
    const deleted = await this.#request("DELETE", this.#userPath(username), VERSIONS.user);
    if (deleted.status === 404) return "already gone";
    if (deleted.status === 401 || deleted.status === 403) return null;
    if (deleted.status !== 204 && deleted.status !== 200)
      throw failure("DELETE", "/databaseUsers/admin/<username>", deleted);
    return "revoked";
  }

  async #applied(cluster: string): Promise<boolean> {
    const path = this.#inProject(`/clusters/${encodeURIComponent(cluster)}/status`);
    for (let polls = 0; polls < POLLS; polls++) {
      const reply = await this.#request("GET", path, VERSIONS.status);
      if (reply.status === 404) return true;
      if (reply.status !== 200) throw failure("GET", "/clusters/<name>/status", reply);
      if (reply.body.changeStatus !== "PENDING") return true;
      await this.#sleep(Math.min(FIRST_WAIT_MS * 2 ** polls, LONGEST_WAIT_MS));
    }
    return false;
  }

  async #user(username: string): Promise<Record<string, unknown> | null> {
    const reply = await this.#request("GET", this.#userPath(username), VERSIONS.user);
    if (reply.status === 404) return null;
    if (reply.status !== 200) throw failure("GET", "/databaseUsers/admin/<username>", reply);
    return reply.body;
  }

  async #clusterFor(hosts: string[]): Promise<Copy["cluster"] | null> {
    const lists = [
      { path: "/clusters", version: VERSIONS.clusters, flex: false },
      { path: "/flexClusters", version: VERSIONS.flex, flex: true },
    ];
    for (const { path, version, flex } of lists) {
      const reply = await this.#request(
        "GET",
        this.#inProject(`${path}?itemsPerPage=500`),
        version,
      );
      if (reply.status !== 200) throw failure("GET", path, reply);
      const results = Array.isArray(reply.body.results) ? reply.body.results : [];
      for (const cluster of results) {
        if (!isRecord(cluster) || typeof cluster.name !== "string") continue;
        const known = new Set(connectionStrings(cluster.connectionStrings).flatMap(hostsOf));
        if (hosts.some((host) => known.has(host))) return { name: cluster.name, flex };
      }
    }
    return null;
  }

  async #signIn(): Promise<Refusal | null> {
    if (this.#token && this.#token.until > this.#now()) return null;
    const secret = (await this.#admin()).reveal().trim();
    if (/(^|:)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secret))
      return {
        ok: false,
        facts: "the admin item holds the private key of a programmatic API key",
        reason:
          "keypin signs in to Atlas with a service account; Atlas calls API keys legacy and recommends service accounts",
        fix: ADMIN_FIX,
      };
    const id = this.#clientId;
    const response = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "keypin",
      },
      body: "grant_type=client_credentials",
    });
    const body = parseObject(await response.text());
    const token = body.access_token;
    if (response.status === 200 && typeof token === "string" && token) {
      const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
      this.#token = { value: token, until: this.#now() + seconds * 1000 - EARLY_MS };
      return null;
    }
    if (response.status === 400 || response.status === 401)
      return {
        ok: false,
        facts: `Atlas answered HTTP ${response.status}`,
        reason: `Atlas doesn't accept service account ${id}: its secret expired or was revoked, or the item holds another value`,
        fix: ADMIN_FIX,
      };
    throw new Error(`Atlas POST /api/oauth/token returned HTTP ${response.status}`);
  }

  #refused(reply: Reply): IssuerCheck {
    const facts = `Atlas answered HTTP ${reply.status}${codeOf(reply)}`;
    if (reply.status === 401 || reply.status === 403 || reply.status === 404)
      return {
        ok: false,
        facts,
        reason: `the service account can't reach Atlas project ${this.#projectId}: the ID is wrong, the service account isn't in the project's organization, or this computer's IP address isn't on its API access list`,
        fix: `check project_id in keypin.toml, and give the service account the Project Database Access Admin role on the project; see ${SERVICE_ACCOUNTS}`,
      };
    throw failure("GET", "/groups/<project_id>", reply);
  }

  #inProject(path: string): string {
    return `/groups/${encodeURIComponent(this.#projectId)}${path}`;
  }

  #userPath(username: string): string {
    return this.#inProject(`/databaseUsers/admin/${encodeURIComponent(username)}`);
  }

  async #request(method: string, path: string, version: string, body?: unknown): Promise<Reply> {
    const signedIn = await this.#signIn();
    if (signedIn) throw new Error(`${signedIn.reason}; ${signedIn.fix}`);
    const media = `application/vnd.atlas.${version}+json`;
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token?.value ?? ""}`,
        Accept: media,
        "User-Agent": "keypin",
        ...(body === undefined ? {} : { "Content-Type": media }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

export function nextName(username: string): string {
  const base = username.replace(/-[ab]$/, "");
  return username.endsWith("-b") ? `${base}-a` : `${base}-b`;
}

function connectionStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(connectionStrings);
  return isRecord(value) ? Object.values(value).flatMap(connectionStrings) : [];
}

function failure(
  method: string,
  path: string,
  reply: Reply,
  type: new (message: string) => Error = Error,
): Error {
  return new type(`Atlas ${method} ${path} returned HTTP ${reply.status}${codeOf(reply)}`);
}

function codeOf(reply: Reply): string {
  const code = reply.body.errorCode;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? ` ${code}` : "";
}
