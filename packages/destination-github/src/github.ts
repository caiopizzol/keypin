import sodium from "libsodium-wrappers";
import {
  type AccountCheck,
  type Destination,
  type Evidence,
  isRecord,
  type Secret,
} from "@keypin/core";
import { ghToken } from "./token";

const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

export interface GitHubSecretOptions {
  repo: string;
  account?: string;
  token?: () => Promise<string>;
  fetch?: Fetch;
}

export class GitHubSecretDestination implements Destination {
  readonly capabilities = { write: true, accountCheck: true, evidence: true } as const;
  readonly #repo: string;
  readonly #owner: string;
  readonly #expected: string;
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #passed = false;

  constructor(options: GitHubSecretOptions) {
    if (!REPO.test(options.repo))
      throw new Error(`"${options.repo}" isn't a GitHub repository in the form owner/name`);
    this.#repo = options.repo;
    this.#owner = options.repo.split("/")[0];
    this.#expected = options.account ?? this.#owner;
    this.#tokenSource = options.token ?? (() => ghToken(this.#expected));
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `github ${this.#repo} (repo secret)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#passed = false;
    const user = await this.#get("/user");
    if (user.status !== 200) throw new Error(`GitHub GET /user returned HTTP ${user.status}`);
    const publisher = stringField(user.body, "login");
    const scopes = user.headers.get("x-oauth-scopes");

    const repo = await this.#get(`/repos/${this.#repo}`);
    const facts = { publisher, expected: this.#expected };
    if (repo.status === 404) {
      return {
        ...facts,
        destinationAccount: null,
        ok: false,
        reason: `${publisher} can't see ${this.#repo}`,
      };
    }
    if (repo.status !== 200)
      throw new Error(`GitHub GET /repos/${this.#repo} returned HTTP ${repo.status}`);
    const owner = stringField(objectField(repo.body, "owner"), "login");
    const admin = objectField(repo.body, "permissions").admin === true;

    const check: AccountCheck = { ...facts, destinationAccount: owner, ok: false };
    if (!sameLogin(owner, this.#owner)) {
      check.reason = `${this.#repo} is owned by ${owner}, not ${this.#owner} (moved or renamed?)`;
    } else if (!sameLogin(publisher, this.#expected)) {
      check.reason = `the token acts as ${publisher}, not ${this.#expected}`;
    } else if (!admin) {
      check.reason = `${publisher} isn't an admin of ${this.#repo}, so it can't write secrets`;
    } else if (scopes !== null && !scopes.split(",").some((s) => s.trim() === "repo")) {
      check.reason = `the token lacks the repo scope (it has: ${scopes || "none"})`;
    } else {
      check.ok = true;
      this.#passed = true;
    }
    return check;
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    if (!this.#passed)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!SECRET_NAME.test(name) || /^GITHUB_/i.test(name))
      throw new Error(`"${name}" isn't a valid GitHub secret name`);

    const key = await this.#get(`/repos/${this.#repo}/actions/secrets/public-key`);
    if (key.status !== 200)
      throw new Error(`GitHub public key for ${this.#repo}: HTTP ${key.status}`);
    const encrypted = await sealedBox(secret.reveal(), stringField(key.body, "key"));

    const path = `/repos/${this.#repo}/actions/secrets/${name}`;
    const put = await this.#request("PUT", path, {
      encrypted_value: encrypted,
      key_id: stringField(key.body, "key_id"),
    });
    if (put.status !== 201 && put.status !== 204)
      throw new Error(`GitHub PUT ${path} returned HTTP ${put.status}`);

    const after = await this.#get(path);
    if (after.status !== 200)
      throw new Error(`GitHub GET ${path} after the write returned HTTP ${after.status}`);
    return {
      destination: this.describe(),
      secret: name,
      created: put.status === 201,
      updatedAt: stringField(after.body, "updated_at"),
    };
  }

  #get(path: string) {
    return this.#request("GET", path);
  }

  async #request(method: string, path: string, body?: unknown) {
    this.#token ??= this.#tokenSource();
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.#token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: parseObject(text) };
  }
}

export async function sealedBox(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  return sodium.to_base64(sodium.crypto_box_seal(value, key), sodium.base64_variants.ORIGINAL);
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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

function stringField(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== "string") throw new Error(`GitHub's response has no "${field}"`);
  return value;
}
