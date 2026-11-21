import {
  type AccountCheck,
  type Destination,
  type Evidence,
  type Fetch,
  parseObject,
  type Secret,
} from "@keypin/core";
import { deploymentOf, refusedName } from "./rules";
import { keyKind, PERMISSION, SETTINGS_PAGE, TOKEN_VARIABLE } from "./token";

export const INVALIDATES =
  "Convex invalidates every subscription when a variable changes; cron definitions read it only on the next deploy";
const VALUE_LIMIT = 8 * 1024;

export interface ConvexEnvOptions {
  url: string;
  key: () => Promise<string>;
  fetch?: Fetch;
}

type Reply = { status: number; body: Record<string, unknown> };

export class ConvexEnvDestination implements Destination {
  readonly #url: string;
  readonly #deployment: string;
  readonly #keySource: () => Promise<string>;
  readonly #fetch: Fetch;
  #key: Promise<string> | undefined;
  #passed = false;

  constructor(options: ConvexEnvOptions) {
    const deployment = deploymentOf(options.url);
    if (!deployment) throw new Error(`"${options.url}" isn't a Convex deployment URL`);
    this.#url = options.url.replace(/\/$/, "");
    this.#deployment = deployment;
    this.#keySource = options.key;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `convex deployment ${this.#deployment} (environment variable)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#passed = false;
    this.#key ??= this.#keySource();
    const kind = keyKind(await this.#key);
    const expected = this.#deployment;
    const generate = `generate a deploy key with ${PERMISSION} in deployment ${expected}'s settings (${SETTINGS_PAGE}) and set ${TOKEN_VARIABLE} to it`;
    const fail = (
      publisher: string,
      reason: string,
      account: string | null = null,
      fix = generate,
    ): AccountCheck => ({
      publisher,
      expected,
      destinationAccount: account,
      ok: false,
      reason,
      fix,
    });

    if (kind.kind === "admin")
      return fail(
        "an admin key",
        `${TOKEN_VARIABLE} holds an admin key, which has complete control of a deployment; keypin takes only a deploy key`,
        kind.name,
      );
    if (kind.kind === "project" || kind.kind === "preview")
      return fail(
        `a ${kind.kind} key`,
        `${TOKEN_VARIABLE} holds a ${kind.kind} key, which doesn't name one deployment; keypin takes a deploy key for deployment ${expected}`,
      );
    if (kind.kind === "unknown")
      return fail(
        "unknown",
        `${TOKEN_VARIABLE} doesn't hold a deploy key for one deployment, such as prod:happy-animal-123|…; keypin doesn't take team access tokens`,
      );
    const publisher = `a ${kind.type} deploy key`;
    if (kind.name !== expected)
      return fail(
        publisher,
        `the deploy key is for deployment ${kind.name}, not ${expected}`,
        kind.name,
        `check url in keypin.toml, or ${generate}`,
      );

    const reached = await this.#request("GET", "/get_canonical_urls");
    if (reached.status === 401 || reached.status === 403)
      return fail(publisher, `deployment ${expected} refused the deploy key`, kind.name);
    if (reached.status !== 200) throw failure("GET", "/get_canonical_urls", reached);
    this.#passed = true;
    return { publisher, expected, destinationAccount: expected, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    if (!this.#passed)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!name) throw new Error("a Convex environment variable needs a name");
    const refused = refusedName(name);
    if (refused) throw new Error(`keypin won't write ${name}: ${refused}`);
    if (new TextEncoder().encode(secret.reveal()).length > VALUE_LIMIT)
      throw new Error(`keypin won't write ${name}: Convex takes values of up to 8 KiB`);
    const sent = await this.#request("POST", "/update_environment_variables", {
      changes: [{ name, value: secret.reveal() }],
    });
    if (sent.status !== 200) throw failure("POST", "/update_environment_variables", sent);
    return { destination: this.describe(), secret: name, action: "set", note: INVALIDATES };
  }

  async #request(method: string, path: string, body?: unknown): Promise<Reply> {
    this.#key ??= this.#keySource();
    const response = await this.#fetch(`${this.#url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Convex ${await this.#key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

const CODE = /^[A-Za-z]{1,64}$/;

function failure(method: string, path: string, reply: Reply): Error {
  const code =
    typeof reply.body.code === "string" && CODE.test(reply.body.code) ? reply.body.code : "";
  const where = `Convex ${method} ${path} returned HTTP ${reply.status}${code ? ` ${code}` : ""}`;
  const why = explain(reply.status, code);
  return new Error(why ? `${why} (${where})` : where);
}

function explain(status: number, code: string): string | null {
  if (status === 401)
    return `Convex refused the deploy key in ${TOKEN_VARIABLE}: it's wrong or deleted; generate a new one at ${SETTINGS_PAGE}`;
  if (status === 403 && code === "OperationNotPermitted")
    return `the deploy key can't change environment variables: generate one with ${PERMISSION} at ${SETTINGS_PAGE}`;
  if (status === 403) return `the deployment refused the deploy key in ${TOKEN_VARIABLE}`;
  if (status === 429)
    return "Convex is rate-limiting the deploy key; wait a minute and run it again";
  return null;
}
