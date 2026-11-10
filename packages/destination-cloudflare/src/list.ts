import { isRecord, type StoreRead } from "@keypin/core";
import type { Fetch } from "./cloudflare";

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const WORKER = /^[A-Za-z0-9_-]+$/;

export class CloudflareReader {
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #accounts: Promise<string[] | { reason: string }> | undefined;

  constructor(options: { token: () => Promise<string>; fetch?: Fetch }) {
    this.#tokenSource = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async listWorkerSecrets(account: string, worker: string): Promise<StoreRead> {
    if (!ACCOUNT_ID.test(account))
      return { ok: false, reason: `"${account}" isn't a Cloudflare account ID` };
    if (!WORKER.test(worker)) return { ok: false, reason: `"${worker}" isn't a Worker name` };
    const accounts = await (this.#accounts ??= this.#accountIds());
    if (!Array.isArray(accounts)) return { ok: false, reason: accounts.reason };
    if (!accounts.includes(account)) {
      return {
        ok: false,
        reason: `the wrangler login reaches ${accounts.join(", ") || "no account"}, not ${account}`,
      };
    }
    const response = await this.#get(`/accounts/${account}/workers/scripts/${worker}/secrets`);
    if ("reason" in response) return { ok: false, reason: response.reason };
    if (response.status === 404)
      return { ok: false, reason: `account ${account} has no Worker named ${worker}` };
    if (response.status !== 200)
      return { ok: false, reason: `Cloudflare returned HTTP ${response.status}` };
    const result = response.body.result;
    if (!Array.isArray(result))
      return { ok: false, reason: "Cloudflare's secrets response has no result list" };
    return {
      ok: true,
      secrets: result.flatMap((s: unknown) =>
        isRecord(s) && typeof s.name === "string" ? [{ name: s.name, updatedAt: null }] : [],
      ),
    };
  }

  async #accountIds(): Promise<string[] | { reason: string }> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const response = await this.#get(`/accounts?per_page=50&page=${page}`);
      if ("reason" in response) return response;
      if (response.status !== 200)
        return { reason: `Cloudflare GET /accounts returned HTTP ${response.status}` };
      const result = response.body.result;
      if (!Array.isArray(result)) return { reason: "Cloudflare's /accounts response has no list" };
      for (const account of result) {
        if (isRecord(account) && typeof account.id === "string") ids.push(account.id);
      }
      const info = response.body.result_info;
      const pages = isRecord(info) ? info.total_pages : undefined;
      if (typeof pages !== "number" || page >= pages) return ids;
    }
  }

  async #get(
    path: string,
  ): Promise<{ status: number; body: Record<string, unknown> } | { reason: string }> {
    let token: string;
    try {
      token = await (this.#token ??= this.#tokenSource());
    } catch (error) {
      return { reason: error instanceof Error ? error.message : "no Cloudflare token" };
    }
    const response = await this.#fetch(`${API}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body: isRecord(body) ? body : {} };
  }
}
