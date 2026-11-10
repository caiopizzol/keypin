import {
  type AccountCheck,
  type Destination,
  type Evidence,
  isRecord,
  type Secret,
} from "@keypin/core";
import { wranglerToken } from "./token";

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const WORKER = /^[A-Za-z0-9_-]+$/;

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

export interface WorkerSecretOptions {
  account: string;
  worker: string;
  token?: () => Promise<string>;
  fetch?: Fetch;
}

export class WorkerSecretDestination implements Destination {
  readonly capabilities = { write: true, accountCheck: true, evidence: true } as const;
  readonly #account: string;
  readonly #worker: string;
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #passed = false;

  constructor(options: WorkerSecretOptions) {
    if (!ACCOUNT_ID.test(options.account))
      throw new Error(`"${options.account}" isn't a Cloudflare account ID`);
    if (!WORKER.test(options.worker)) throw new Error(`"${options.worker}" isn't a Worker name`);
    this.#account = options.account;
    this.#worker = options.worker;
    this.#tokenSource = options.token ?? (() => wranglerToken());
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `cloudflare worker ${this.#worker} in account ${this.#account} (worker secret)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#passed = false;
    const facts = { publisher: await this.#publisher(), expected: this.#account };

    const accounts = await this.#accountIds();
    if (!accounts.includes(this.#account)) {
      const reason = `the login can reach ${accounts.join(", ") || "no account"}, not ${this.#account}`;
      return { ...facts, destinationAccount: null, ok: false, reason };
    }

    const settings = await this.#request("GET", `${this.#base()}/settings`);
    if (settings.status === 404) {
      const reason = `account ${this.#account} has no Worker ${this.#worker}`;
      return { ...facts, destinationAccount: null, ok: false, reason };
    }
    if (settings.status !== 200) throw failure("GET", `${this.#base()}/settings`, settings);

    this.#passed = true;
    return { ...facts, destinationAccount: this.#account, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    if (!this.#passed)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!name) throw new Error("a Worker secret needs a name");

    const path = `${this.#base()}/secrets`;
    const put = await this.#request("PUT", path, {
      name,
      text: secret.reveal(),
      type: "secret_text",
    });
    if (put.status !== 200) throw failure("PUT", path, put);

    const versions = await this.#request("GET", `${this.#base()}/versions?per_page=10`);
    if (versions.status !== 200) throw failure("GET", `${this.#base()}/versions`, versions);
    const newest = newestVersion(versions.body);
    return {
      destination: this.describe(),
      secret: name,
      versionId: newest.id,
      createdOn: newest.createdOn,
      triggeredBySecret: newest.triggeredBy === "secret",
      note: "a Worker's secret-change version covers all of its secrets, not only this one",
    };
  }

  #base(): string {
    return `/accounts/${this.#account}/workers/scripts/${this.#worker}`;
  }

  async #publisher(): Promise<string> {
    const user = await this.#request("GET", "/user");
    const email = user.status === 200 ? objectField(user.body, "result").email : undefined;
    return typeof email === "string" ? email : "unknown (the token can't read /user)";
  }

  async #accountIds(): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const response = await this.#request("GET", `/accounts?per_page=50&page=${page}`);
      if (response.status !== 200) throw failure("GET", "/accounts", response);
      const result = response.body.result;
      if (!Array.isArray(result))
        throw new Error("Cloudflare's /accounts response has no result list");
      for (const account of result) {
        if (isRecord(account) && typeof account.id === "string") ids.push(account.id);
      }
      const pages = objectField(response.body, "result_info").total_pages;
      if (typeof pages !== "number" || page >= pages) return ids;
    }
  }

  async #request(method: string, path: string, body?: unknown) {
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

function failure(
  method: string,
  path: string,
  response: { status: number; body: Record<string, unknown> },
): Error {
  const errors = response.body.errors;
  const codes = Array.isArray(errors)
    ? errors
        .map((e: unknown) => (isRecord(e) ? e.code : undefined))
        .filter((c): c is string | number => typeof c === "string" || typeof c === "number")
    : [];
  const detail = codes.length ? `, codes ${codes.join(", ")}` : "";
  return new Error(
    `Cloudflare ${method} ${path.split("?")[0]} returned HTTP ${response.status}${detail}`,
  );
}

function newestVersion(body: Record<string, unknown>) {
  const items = objectField(body, "result").items;
  if (!Array.isArray(items)) throw new Error("Cloudflare's versions response has no items");
  const versions = items.map((item: unknown) => {
    const v = isRecord(item) ? item : {};
    const createdOn = objectField(v, "metadata").created_on;
    return {
      id: typeof v.id === "string" ? v.id : null,
      createdOn: typeof createdOn === "string" ? createdOn : null,
      triggeredBy: objectField(v, "annotations")["workers/triggered_by"],
    };
  });
  versions.sort((a, b) => Date.parse(b.createdOn ?? "") - Date.parse(a.createdOn ?? ""));
  const newest = versions[0];
  if (!newest?.id || !newest.createdOn)
    throw new Error("Cloudflare listed no version for the Worker after the write");
  return newest;
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

function objectField(data: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = data[field];
  return isRecord(value) ? value : {};
}
