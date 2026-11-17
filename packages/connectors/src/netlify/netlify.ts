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
import { TOKEN_VARIABLE, TOKENS_PAGE } from "./token";

const API = "https://api.netlify.com/api/v1";
export const CONTEXTS = ["production", "deploy-preview", "branch-deploy", "dev-server"];
export const REBUILD =
  "Netlify uses the new value only from the next build and deploy; redeploy to use it";
const SCOPES = ["builds", "functions", "runtime"];

export interface NetlifyEnvOptions {
  team: string;
  project: string;
  context: string;
  token: () => Promise<string>;
  fetch?: Fetch;
}

type Reply = { status: number; body: unknown };
type Site = { id: string; account: string };

export class NetlifyEnvDestination implements Destination {
  readonly #team: string;
  readonly #project: string;
  readonly #context: string;
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #site: Site | null = null;

  constructor(options: NetlifyEnvOptions) {
    if (!CONTEXTS.includes(options.context))
      throw new Error(`"${options.context}" isn't a Netlify deploy context keypin writes`);
    this.#team = options.team;
    this.#project = options.project;
    this.#context = options.context;
    this.#tokenSource = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `netlify project ${this.#project} in team ${this.#team}, deploy context ${this.#context} (secret variable)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#site = null;
    const facts = { publisher: await this.#publisher(), expected: this.#team };
    const fail = (reason: string, fix: string, account: string | null = null): AccountCheck => ({
      ...facts,
      destinationAccount: account,
      ok: false,
      reason,
      fix,
    });
    const tokenFix = `create a personal access token at ${TOKENS_PAGE} as a member of team ${this.#team}, and set ${TOKEN_VARIABLE} to it; if the team uses SAML single sign-on, allow the token access to it`;

    const site = await this.#request("GET", `/sites/${encodeURIComponent(this.#project)}`);
    if (site.status === 401) return fail("Netlify refused the token", tokenFix);
    if (site.status === 403 || site.status === 404)
      return fail(
        `the token can't reach the project ${this.#project}`,
        `check project in keypin.toml, or ${tokenFix}`,
      );
    if (site.status !== 200) throw failure("GET", "/sites", site);
    const body = isRecord(site.body) ? site.body : {};
    const { id, account_slug: slug, account_id: accountId } = body;
    if (typeof id !== "string" || typeof slug !== "string")
      throw new Error("Netlify's project reply has no id or account_slug");
    if (this.#team !== slug && this.#team !== accountId)
      return fail(
        `the project ${this.#project} belongs to team ${slug}, not ${this.#team}`,
        `set team to ${slug} in keypin.toml if that's the right project, or check project`,
        slug,
      );

    this.#site = { id, account: slug };
    return { ...facts, destinationAccount: this.#team, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    const site = this.#site;
    if (!site)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!name) throw new Error("a Netlify environment variable needs a name");
    const existing = await this.#existing(site, name);
    const value = { context: this.#context, value: secret.reveal() };
    if (existing) {
      const path = this.#path(site, `/${encodeURIComponent(name)}`);
      const sent = await this.#request("PATCH", path, value);
      if (sent.status !== 200 && sent.status !== 201)
        throw failure("PATCH", "/accounts/env", sent, { echoesValue: true });
    } else {
      const created = [{ key: name, is_secret: true, scopes: SCOPES, values: [value] }];
      const sent = await this.#request("POST", this.#path(site, ""), created);
      if (sent.status !== 200 && sent.status !== 201)
        throw failure("POST", "/accounts/env", sent, { echoesValue: true });
    }
    return {
      destination: this.describe(),
      secret: name,
      context: this.#context,
      action: existing === "this context" ? "updated" : "created",
      type: "secret",
      note: REBUILD,
    };
  }

  async #existing(site: Site, name: string): Promise<"this context" | "other contexts" | null> {
    const listed = await this.#request("GET", this.#path(site, ""));
    if (listed.status !== 200) throw failure("GET", "/accounts/env", listed);
    if (!Array.isArray(listed.body))
      throw new Error("Netlify's environment variable list isn't a list");
    const found = listed.body.filter(isRecord).find((env) => env.key === name);
    if (!found) return null;
    if (found.is_secret !== true)
      throw new Error(
        `${name} in the Netlify project ${this.#project} isn't marked as containing secret values, so the value keypin writes would be readable in Netlify. In Netlify, edit ${name} and select Contains secret values, or delete it, then publish again`,
      );
    const values = Array.isArray(found.values) ? found.values.filter(isRecord) : [];
    return values.some((v) => v.context === this.#context) ? "this context" : "other contexts";
  }

  #path(site: Site, rest: string): string {
    return `/accounts/${encodeURIComponent(site.account)}/env${rest}?site_id=${encodeURIComponent(site.id)}`;
  }

  async #publisher(): Promise<string> {
    const reply = await this.#request("GET", "/user");
    const user = isRecord(reply.body) ? reply.body : {};
    const name = user.email ?? user.full_name;
    return reply.status === 200 && typeof name === "string"
      ? name
      : "unknown (the token can't read its user)";
  }

  async #request(method: string, path: string, body?: unknown): Promise<Reply> {
    this.#token ??= this.#tokenSource();
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.#token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: list(text) ?? parseObject(text) };
  }
}

function list(text: string): unknown[] | null {
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function failure(
  method: string,
  path: string,
  reply: Reply,
  write = { echoesValue: false },
): Error {
  const body = isRecord(reply.body) ? reply.body : {};
  const said = write.echoesValue
    ? []
    : [body.message, objectField(body, "error").message]
        .map((m) => (typeof m === "string" ? m.trim() : ""))
        .filter((m) => m);
  const where = `Netlify ${method} ${path} returned HTTP ${reply.status}`;
  const detail = said.length ? `, "${[...new Set(said)].join("; ")}"` : "";
  const why = explain(reply);
  return new Error(`${why ? `${why} (` : ""}${where}${detail}${why ? ")" : ""}`);
}

function explain(reply: Reply): string | null {
  if (reply.status === 401)
    return `Netlify refused the token in ${TOKEN_VARIABLE}: it's wrong, expired or deleted; create a new one at ${TOKENS_PAGE}`;
  if (reply.status === 403)
    return "the token can't change this project's environment variables; use a token from a member of its team";
  if (reply.status === 429)
    return "Netlify is rate-limiting the token; wait a minute and run it again";
  return null;
}
