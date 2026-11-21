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
import { refusedName } from "./rules";
import { TOKEN_VARIABLE, TOKENS_PAGE } from "./token";

const API = "https://api.machines.dev/v1";
export const STAGED =
  "Fly.io stages the new value; Machines use it only after fly secrets deploy or the app's next deploy, which keypin doesn't run";

export interface FlySecretsOptions {
  app: string;
  org?: string;
  token: () => Promise<string>;
  fetch?: Fetch;
}

type Reply = { status: number; body: Record<string, unknown> };
type Token = { org: string; apps: string[] | null };

export class FlySecretsDestination implements Destination {
  readonly #app: string;
  readonly #org: string | undefined;
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #passed = false;

  constructor(options: FlySecretsOptions) {
    this.#app = options.app;
    this.#org = options.org;
    this.#tokenSource = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `fly app ${this.#app} (secret)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#passed = false;
    const app = this.#app;
    const create = `create a deploy token with fly tokens create deploy -a ${app}, or an org token for the app's organization (${TOKENS_PAGE}), and set ${TOKEN_VARIABLE} to it`;

    const current = await this.#request("GET", "/tokens/current");
    if (current.status === 401)
      return refused("unknown", app, `Fly.io refused the token in ${TOKEN_VARIABLE}`, create);
    const tokens = current.status === 200 ? scoped(current.body) : [];
    const publisher = describeTokens(tokens);
    const fail = (reason: string, account: string | null = null, fix = create) =>
      refused(publisher, app, reason, fix, account);

    const forApps = tokens.flatMap((t) => t.apps ?? []);
    if (forApps.length && tokens.every((t) => t.apps) && !forApps.includes(app))
      return fail(`the deploy token is for ${list(forApps)}, not ${app}`, null);

    const reply = await this.#request("GET", `/apps/${encodeURIComponent(app)}`);
    if (reply.status === 401 || reply.status === 403 || reply.status === 404)
      return fail(
        `the token can't reach the app ${app}`,
        null,
        `check app in keypin.toml, or ${create}`,
      );
    if (reply.status !== 200) throw failure("GET", "/apps/{app}", reply);
    const slug = objectField(reply.body, "organization").slug;
    const org = typeof slug === "string" ? slug : null;
    if (this.#org !== undefined && org !== this.#org)
      return fail(
        `the app ${app} belongs to the organization ${org ?? "unknown"}, not ${this.#org}`,
        app,
        "check org in keypin.toml",
      );
    this.#passed = true;
    return { publisher, expected: app, destinationAccount: app, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    if (!this.#passed)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!name) throw new Error("a Fly.io secret needs a name");
    const refused = refusedName(name);
    if (refused) throw new Error(`keypin won't write ${name}: ${refused}`);
    const path = `/apps/${encodeURIComponent(this.#app)}/secrets/${encodeURIComponent(name)}`;
    const sent = await this.#request("POST", path, { value: secret.reveal() });
    if (sent.status !== 200 && sent.status !== 201)
      throw failure("POST", "/apps/{app}/secrets/{name}", sent);
    const version = sent.body.version;
    return {
      destination: this.describe(),
      secret: name,
      action: "set",
      version: typeof version === "number" ? version : null,
      deployed: false,
      note: STAGED,
    };
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
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

function refused(
  publisher: string,
  expected: string,
  reason: string,
  fix: string,
  account: string | null = null,
): AccountCheck {
  return { publisher, expected, destinationAccount: account, ok: false, reason, fix };
}

function scoped(body: Record<string, unknown>): Token[] {
  const tokens = Array.isArray(body.tokens) ? body.tokens : [];
  return tokens.filter(isRecord).flatMap((t) => {
    if (typeof t.org_slug !== "string") return [];
    const apps = Array.isArray(t.apps) ? t.apps.filter((a) => typeof a === "string") : null;
    return [{ org: t.org_slug, apps: apps?.length ? apps : null }];
  });
}

function describeTokens(tokens: Token[]): string {
  const [token, ...more] = tokens;
  if (!token || more.length) return "a Fly.io token";
  return token.apps
    ? `a Fly.io deploy token for ${list(token.apps)}`
    : `a Fly.io org token for ${token.org}`;
}

const list = (apps: string[]) => apps.join(", ");

function failure(method: string, path: string, reply: Reply): Error {
  const where = `Fly.io ${method} ${path} returned HTTP ${reply.status}`;
  const why = explain(reply.status);
  return new Error(why ? `${why} (${where})` : where);
}

function explain(status: number): string | null {
  if (status === 401)
    return `Fly.io refused the token in ${TOKEN_VARIABLE}: it's wrong, expired or revoked; create a new one (${TOKENS_PAGE})`;
  if (status === 403)
    return `the token in ${TOKEN_VARIABLE} can't change the app's secrets; a read-only token can't, so use a deploy or org token (${TOKENS_PAGE})`;
  if (status === 404) return "Fly.io has no such app, or the token can't see it";
  if (status === 429) return "Fly.io is rate-limiting the token; wait a minute and run it again";
  return null;
}
