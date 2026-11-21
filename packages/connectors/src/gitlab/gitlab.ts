import {
  type AccountCheck,
  type Destination,
  type Evidence,
  type Fetch,
  isRecord,
  objectField,
  parseObject,
  type Secret,
} from "@keypin/core";
import { DEFAULT_HOST, HOST, NAME, type Owner, PATH } from "./rules";
import { type SignInVia, TOKEN_VARIABLE, tokensPage } from "./token";

export const NEXT_PIPELINE =
  "GitLab uses the new value from the next pipeline; keypin doesn't start one";
const MASKABLE = /^\S{8,}$/;
const MASKABLE_EXPANDED = /^[A-Za-z0-9_+=/@:.~-]{8,}$/;
const JOB_TOKEN = "glcbt-";
const NEEDS_API = "changing CI/CD variables needs a token with the api scope";

const ROLE: Record<Owner, string> = { project: "Maintainer", group: "Owner" };
const REST: Record<Owner, string> = { project: "projects", group: "groups" };

export interface GitLabVariablesOptions {
  owner: Owner;
  host: string;
  path: string;
  environmentScope: string;
  token: () => Promise<string>;
  via: SignInVia;
  fetch?: Fetch;
}

type Reply = { status: number; body: Record<string, unknown> };
type Listed = {
  key: string;
  environmentScope: string;
  masked: boolean;
  hidden: boolean;
  protected: boolean;
  raw: boolean;
};

export class GitLabVariablesDestination implements Destination {
  readonly #owner: Owner;
  readonly #host: string;
  readonly #path: string;
  readonly #scope: string;
  readonly #via: SignInVia;
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #passed = false;

  constructor(options: GitLabVariablesOptions) {
    if (!HOST.test(options.host)) throw new Error(`"${options.host}" isn't a GitLab host`);
    if (!PATH.test(options.path))
      throw new Error(`"${options.path}" isn't a GitLab ${options.owner}`);
    if (!options.environmentScope) throw new Error("a GitLab environment scope can't be empty");
    this.#owner = options.owner;
    this.#host = options.host;
    this.#path = options.path;
    this.#scope = options.environmentScope;
    this.#via = options.via;
    this.#tokenSource = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    const scope = this.#scope === "*" ? "" : `, environment scope ${this.#scope}`;
    return `gitlab ${this.#owner} ${this.#path} on ${this.#host}${scope} (masked variable)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#passed = false;
    const expected = this.#path.split("/")[0] ?? this.#path;
    const facts = { expected, publisher: "unknown" };
    const fail = (reason: string, fix: string, publisher = facts.publisher): AccountCheck => ({
      ...facts,
      publisher,
      destinationAccount: null,
      ok: false,
      reason,
      fix,
    });
    const role = ROLE[this.#owner];
    const create = `create a ${this.#owner} access token with the ${role} role and the api scope, or a personal access token with the api scope from a ${role} (${tokensPage(this.#host)}), and set ${TOKEN_VARIABLE} to it`;

    if ((await this.#tokenValue()).startsWith(JOB_TOKEN))
      return fail(`a CI/CD job token can't change CI/CD variables`, create);

    const found = await this.#graphql(
      `query($path: ID!) { currentUser { username } ${this.#owner}(fullPath: $path) { ciVariables(first: 1) { nodes { key } } } }`,
      { path: this.#path },
    );
    if (found.status === 401) return fail(this.#refused(), create);
    if (found.status === 403) return fail(NEEDS_API, create);
    if (found.status !== 200) throw failure("POST", "/api/graphql", found);
    const data = objectField(found.body, "data");
    const user = objectField(data, "currentUser").username;
    const publisher = typeof user === "string" ? user : "unknown (the token can't read its user)";

    const scopes = await this.#scopes();
    if (scopes !== null && !scopes.includes("api"))
      return fail(`${NEEDS_API}; it has ${scopes.join(", ") || "none"}`, create, publisher);

    const place = data[this.#owner];
    if (!isRecord(place))
      return fail(
        `the login can't reach the ${this.#owner} ${this.#path} on ${this.#host}`,
        `check ${this.#owner}${this.#host === DEFAULT_HOST ? "" : " and host"} in keypin.toml, or ${create}`,
        publisher,
      );
    if (!isRecord(place.ciVariables))
      return fail(
        `the login reaches the ${this.#owner} ${this.#path} but can't change its CI/CD variables, which needs the ${role} role`,
        create,
        publisher,
      );

    this.#passed = true;
    return { ...facts, publisher, destinationAccount: expected, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    if (!this.#passed)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!NAME.test(name))
      throw new Error(`GitLab variable names use only letters, digits and _, up to 255`);
    const value = secret.reveal();
    if (!MASKABLE.test(value))
      throw new Error(
        `GitLab masks only a value of 8 or more characters with no spaces or line breaks; ${name}'s value isn't, so keypin won't write it unmasked`,
      );
    const existing = await this.#existing(name);
    if (existing && !existing.raw && !MASKABLE_EXPANDED.test(value))
      throw new Error(
        `${name} in GitLab expands variable references, so a masked value may use only letters, digits and _+=/@:.~-; turn off Expand variable reference on it in GitLab, then publish again`,
      );

    const base = `/api/v4/${REST[this.#owner]}/${encodeURIComponent(this.#path)}/variables`;
    const hidden = async () => [value, await this.#tokenValue()];
    let reply: Reply;
    if (existing) {
      const filter = `?filter%5Benvironment_scope%5D=${encodeURIComponent(this.#scope)}`;
      reply = await this.#request("PUT", `${base}/${name}${filter}`, { value, masked: true });
      if (reply.status !== 200) throw failure("PUT", `${base}/:key`, reply, await hidden());
    } else {
      reply = await this.#request("POST", base, {
        key: name,
        value,
        masked: true,
        masked_and_hidden: true,
        raw: true,
        ...(this.#owner === "project" ? { environment_scope: this.#scope } : {}),
      });
      if (reply.status !== 201 && reply.status !== 200)
        throw failure("POST", base, reply, await hidden());
    }
    return {
      destination: this.describe(),
      secret: name,
      action: existing ? "updated" : "created",
      environmentScope: this.#scope,
      masked: true,
      hidden: reply.body.hidden === true,
      protected: reply.body.protected === true,
      note: NEXT_PIPELINE,
    };
  }

  async #existing(name: string): Promise<Listed | null> {
    let after: string | null = null;
    do {
      const page = await this.#graphql(
        `query($path: ID!, $after: String) { ${this.#owner}(fullPath: $path) { ciVariables(first: 100, after: $after) { nodes { key environmentScope masked hidden protected raw } pageInfo { hasNextPage endCursor } } } }`,
        { path: this.#path, after },
      );
      if (page.status !== 200) throw failure("POST", "/api/graphql", page);
      const variables = objectField(
        objectField(objectField(page.body, "data"), this.#owner),
        "ciVariables",
      );
      if (!Array.isArray(variables.nodes))
        throw new Error(`GitLab didn't list the CI/CD variables of ${this.#path}${said(page)}`);
      const nodes: unknown[] = variables.nodes;
      const mine = nodes
        .filter(isRecord)
        .find((v) => v.key === name && (v.environmentScope ?? "*") === this.#scope);
      if (mine)
        return {
          key: name,
          environmentScope: this.#scope,
          masked: mine.masked === true,
          hidden: mine.hidden === true,
          protected: mine.protected === true,
          raw: mine.raw !== false,
        };
      const info = objectField(variables, "pageInfo");
      after =
        info.hasNextPage === true && typeof info.endCursor === "string" ? info.endCursor : null;
    } while (after !== null);
    return null;
  }

  async #scopes(): Promise<string[] | null> {
    const reply = await this.#request("GET", "/api/v4/personal_access_tokens/self");
    if (reply.status !== 200 || !Array.isArray(reply.body.scopes)) return null;
    const scopes: unknown[] = reply.body.scopes;
    return scopes.filter((s): s is string => typeof s === "string");
  }

  #refused(): string {
    return this.#via === "glab"
      ? `GitLab refused the glab login for ${this.#host}; run glab auth login --hostname ${this.#host}`
      : `GitLab refused the token in ${TOKEN_VARIABLE}: it's wrong, expired or revoked`;
  }

  #tokenValue(): Promise<string> {
    this.#token ??= this.#tokenSource();
    return this.#token;
  }

  #graphql(query: string, variables: Record<string, unknown>): Promise<Reply> {
    return this.#request("POST", "/api/graphql", { query, variables });
  }

  async #request(method: string, path: string, body?: unknown): Promise<Reply> {
    const token = await this.#tokenValue();
    const response = await this.#fetch(`https://${this.#host}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

function said(reply: Reply, hidden: readonly string[] = []): string {
  const secrets = hidden.flatMap((h) => [h, h.trim()]).filter((h) => h);
  const messages = [
    reply.body.message,
    reply.body.error,
    ...(Array.isArray(reply.body.errors)
      ? reply.body.errors.filter(isRecord).map((e) => e.message)
      : []),
  ].flatMap(texts);
  const kept = messages.filter((m) => !secrets.some((h) => m.includes(h)));
  return kept.length ? `, "${[...new Set(kept)].join("; ")}"` : "";
}

function texts(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (isRecord(value))
    return Object.entries(value).flatMap(([field, v]) => texts(v).map((m) => `${field} ${m}`));
  return [];
}

function failure(
  method: string,
  path: string,
  reply: Reply,
  hidden: readonly string[] = [],
): Error {
  const where = `GitLab ${method} ${path} returned HTTP ${reply.status}${said(reply, hidden)}`;
  const why =
    reply.status === 401
      ? `GitLab refused the login`
      : reply.status === 403
        ? `the login can't change these CI/CD variables; it needs the api scope and the Maintainer role on a project, or Owner on a group`
        : reply.status === 429
          ? "GitLab is rate-limiting the login; wait a few minutes and run it again"
          : null;
  return new Error(why ? `${why} (${where})` : where);
}
