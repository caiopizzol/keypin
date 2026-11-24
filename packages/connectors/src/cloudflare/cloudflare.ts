import {
  type AccountCheck,
  type Destination,
  type Evidence,
  type Fetch,
  isRecord,
  objectField,
  type Secret,
} from "@keypin/core";
import { call, errorCodes, type Reply, returned } from "./api";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const WORKER = /^[A-Za-z0-9_-]+$/;
const DENIED = [401, 403];

interface WorkerSecretOptions {
  account: string;
  worker: string;
  token: () => Promise<string>;
  fetch?: Fetch;
}

export class WorkerSecretDestination implements Destination {
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
    this.#tokenSource = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `cloudflare worker ${this.#worker} in account ${this.#account} (worker secret)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#passed = false;
    const facts = { publisher: await this.#publisher(), expected: this.#account };

    const fix = `sign in as a member of account ${this.#account}, or use an API token with Workers Scripts Edit on it`;
    const accounts = await this.#accountIds();
    if (accounts !== null && !accounts.includes(this.#account)) {
      const reason = `the login can reach ${accounts.join(", ") || "no account"}, not ${this.#account}`;
      return { ...facts, destinationAccount: null, ok: false, reason, fix };
    }

    const settings = await this.#request("GET", `${this.#base()}/settings`);
    if (settings.status === 404) {
      const reason = `account ${this.#account} has no Worker ${this.#worker}`;
      const fix = `deploy the Worker first, or fix worker in secretspec.toml. A Worker in a Workers for Platforms dispatch namespace isn't listed here, and keypin doesn't publish to one`;
      return { ...facts, destinationAccount: null, ok: false, reason, fix };
    }
    if (accounts === null && DENIED.includes(settings.status)) {
      const reason = `the login can't list its accounts or read the Worker ${this.#worker} in account ${this.#account}`;
      return { ...facts, destinationAccount: null, ok: false, reason, fix };
    }
    if (settings.status !== 200) throw failure("GET", `${this.#base()}/settings`, settings);

    this.#passed = true;
    return { ...facts, destinationAccount: this.#account, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    if (!name) throw new Error("a Worker secret needs a name");
    return this.writeMany([{ name, secret }]);
  }

  async writeMany(secrets: readonly { name: string; secret: Secret }[]): Promise<Evidence> {
    if (!this.#passed)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    const [only] = secrets;
    const path = `${this.#base()}/${secrets.length === 1 ? "secrets" : "secrets-bulk"}`;
    const text = (name: string, secret: Secret) => ({
      name,
      text: secret.reveal(),
      type: "secret_text",
    });
    const sent =
      secrets.length === 1 && only
        ? await this.#request("PUT", path, text(only.name, only.secret))
        : await this.#request(
            "PATCH",
            path,
            { secrets: Object.fromEntries(secrets.map((s) => [s.name, text(s.name, s.secret)])) },
            "application/merge-patch+json",
          );
    if (sent.status !== 200 && sent.status !== 201)
      throw failure(secrets.length === 1 ? "PUT" : "PATCH", path, sent, [
        ...secrets.map((s) => s.secret.reveal()),
        await this.#tokenOrEmpty(),
      ]);

    const versions = await this.#request("GET", `${this.#base()}/versions?per_page=10`);
    if (versions.status !== 200) throw failure("GET", `${this.#base()}/versions`, versions);
    const newest = newestVersion(versions.body);
    return {
      destination: this.describe(),
      secret: secrets.map((s) => s.name).join(", "),
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

  async #accountIds(): Promise<string[] | null> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const response = await this.#request("GET", `/accounts?per_page=50&page=${page}`);
      if (DENIED.includes(response.status)) return null;
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

  async #tokenOrEmpty(): Promise<string> {
    return this.#token ? await this.#token.catch(() => "") : "";
  }

  async #request(method: string, path: string, body?: unknown, type?: string): Promise<Reply> {
    this.#token ??= this.#tokenSource();
    return call(this.#fetch, await this.#token, method, path, body, type);
  }
}

const NOT_DEPLOYED = [10214, 10215];

function failure(method: string, path: string, response: Reply, hidden?: readonly string[]): Error {
  const where = returned(method, path, response, hidden);
  const why = explain(response.status, errorCodes(response));
  return new Error(why ? `${why} (${where})` : where);
}

function explain(status: number, codes: readonly number[]): string | null {
  if (codes.some((code) => NOT_DEPLOYED.includes(code)))
    return "the Worker's latest version isn't deployed, and writing a secret would deploy it; deploy the latest version first (wrangler versions deploy), or set the secret on a new version with wrangler versions secret put";
  if (status === 401)
    return "Cloudflare refused the sign-in; run wrangler login again, or check KEYPIN_CLOUDFLARE_API_TOKEN";
  if (status === 403)
    return "the login can't edit this Worker's secrets; it needs Workers Scripts Edit on the account";
  if (status === 429)
    return "Cloudflare is rate-limiting the login (1,200 requests per 5 minutes); wait a few minutes and run it again";
  return null;
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
