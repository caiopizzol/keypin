import {
  isRecord,
  type Json,
  type ProviderToken,
  Secret,
  type TokenPolicy,
  type TokenProvider,
  type VerifiedToken,
} from "@keypin/core";

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const TOKEN_ID = /^[0-9a-f]{32}$/;

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

export interface AccountTokenOptions {
  account: string;
  admin: Secret;
  fetch?: Fetch;
}

type Reply = { status: number; body: Record<string, unknown> };

export class CloudflareAccountTokens implements TokenProvider {
  readonly #account: string;
  readonly #admin: Secret;
  readonly #fetch: Fetch;

  constructor(options: AccountTokenOptions) {
    if (!ACCOUNT_ID.test(options.account))
      throw new Error(`"${options.account}" isn't a Cloudflare account ID`);
    this.#account = options.account;
    this.#admin = options.admin;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `Cloudflare account API tokens in account ${this.#account}`;
  }

  async verify(secret: Secret): Promise<VerifiedToken> {
    const path = `${this.#base()}/verify`;
    const reply = await this.#request("GET", path, secret);
    if (reply.status !== 200) throw failure("GET", path, reply);
    const result = objectField(reply.body, "result");
    return {
      id: tokenId(result.id, "verify"),
      status: text(result.status, "status"),
      expiresOn: optionalText(result.expires_on),
    };
  }

  async details(id: string): Promise<ProviderToken | null> {
    const path = `${this.#base()}/${tokenId(id, "details")}`;
    const reply = await this.#request("GET", path, this.#admin);
    if (reply.status === 404) return null;
    if (reply.status !== 200) throw failure("GET", path, reply);
    return token(objectField(reply.body, "result"));
  }

  async issue(request: {
    name: string;
    like: ProviderToken;
    expiresOn: string;
  }): Promise<{ token: ProviderToken; value: Secret } | { refused: string }> {
    const path = this.#base();
    const body: Record<string, Json> = {
      name: request.name,
      policies: request.like.policies.map((policy) => ({
        effect: policy.effect,
        resources: policy.resources,
        permission_groups: policy.permissionGroups.map((group) => ({ id: group.id })),
      })),
      expires_on: request.expiresOn,
    };
    if (request.like.condition) body.condition = request.like.condition;
    const reply = await this.#request("POST", path, this.#admin, body);
    if (reply.status >= 400 && reply.status < 500)
      return { refused: failure("POST", path, reply).message };
    if (reply.status !== 200) throw failure("POST", path, reply);
    const result = objectField(reply.body, "result");
    const value = result.value;
    if (typeof value !== "string" || !value)
      throw new Error("Cloudflare's create response has no token value");
    return { token: token(result), value: new Secret(value) };
  }

  async revoke(id: string): Promise<"revoked" | "already gone"> {
    const path = `${this.#base()}/${tokenId(id, "revoke")}`;
    const reply = await this.#request("DELETE", path, this.#admin);
    if (reply.status === 404) return "already gone";
    if (reply.status !== 200) throw failure("DELETE", path, reply);
    return "revoked";
  }

  #base(): string {
    return `/accounts/${this.#account}/tokens`;
  }

  async #request(method: string, path: string, auth: Secret, body?: Json): Promise<Reply> {
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth.reveal()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: parseObject(await response.text()) };
  }
}

function token(result: Record<string, unknown>): ProviderToken {
  const policies = result.policies;
  if (!Array.isArray(policies)) throw new Error("Cloudflare's token has no policies list");
  const condition = result.condition;
  return {
    id: tokenId(result.id, "token"),
    name: text(result.name, "name"),
    status: text(result.status, "status"),
    expiresOn: optionalText(result.expires_on),
    lastUsedOn: optionalText(result.last_used_on),
    policies: policies.map(policy),
    condition: isJsonObject(condition) && Object.keys(condition).length ? condition : null,
  };
}

function policy(raw: unknown): TokenPolicy {
  if (!isRecord(raw)) throw new Error("a Cloudflare token policy isn't an object");
  const resources = raw.resources;
  const groups = raw.permission_groups;
  if (!isJsonObject(resources)) throw new Error("a Cloudflare token policy has no resources");
  if (!Array.isArray(groups)) throw new Error("a Cloudflare token policy has no permission groups");
  return {
    effect: text(raw.effect, "effect"),
    resources,
    permissionGroups: groups.map((group: unknown) => {
      if (!isRecord(group)) throw new Error("a Cloudflare permission group isn't an object");
      return {
        id: text(group.id, "permission group id"),
        name: typeof group.name === "string" ? group.name : "(unnamed)",
      };
    }),
  };
}

function isJson(value: unknown): value is Json {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return isJsonObject(value);
}

function isJsonObject(value: unknown): value is { readonly [key: string]: Json } {
  return isRecord(value) && Object.values(value).every(isJson);
}

function tokenId(value: unknown, where: string): string {
  if (typeof value !== "string" || !TOKEN_ID.test(value))
    throw new Error(`Cloudflare's ${where} response has no valid token ID`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Cloudflare's token has no "${field}"`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function failure(method: string, path: string, reply: Reply): Error {
  const errors = reply.body.errors;
  const codes = Array.isArray(errors)
    ? errors
        .map((e: unknown) => (isRecord(e) ? e.code : undefined))
        .filter((c): c is string | number => typeof c === "string" || typeof c === "number")
    : [];
  const detail = codes.length ? `, codes ${codes.join(", ")}` : "";
  return new Error(
    `Cloudflare ${method} ${path.split("?")[0]} returned HTTP ${reply.status}${detail}`,
  );
}

function parseObject(body: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(body);
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

function objectField(data: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = data[field];
  return isRecord(value) ? value : {};
}
