import sodium from "libsodium-wrappers";
import {
  type AccountCheck,
  type Destination,
  type Evidence,
  type Expiry,
  type Fetch,
  objectField,
  parseObject,
  type Secret,
} from "@keypin/core";
import { gitHubSaid, NOT_ENTERPRISE, ssoFix } from "./refusal";

const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_BYTES = 48 * 1024;
const MAX_SECRETS = 100;

type Reply = { status: number; headers: Headers; body: Record<string, unknown> };
type Refusal = { reason: string; fix: string };

export interface GitHubSecretOptions {
  repo: string;
  environment?: string;
  login?: string | null;
  token: () => Promise<string>;
  fetch?: Fetch;
}

export class GitHubSecretDestination implements Destination {
  readonly #repo: string;
  readonly #owner: string;
  readonly #environment: string | null;
  readonly #secrets: string;
  readonly #login: string | null;
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #passed = false;

  constructor(options: GitHubSecretOptions) {
    if (!REPO.test(options.repo))
      throw new Error(`"${options.repo}" isn't a GitHub repository in the form owner/name`);
    this.#repo = options.repo;
    const [owner = ""] = options.repo.split("/");
    this.#owner = owner;
    this.#environment = options.environment ?? null;
    this.#secrets = secretsPath(options.repo, options.environment);
    this.#login = options.login ?? null;
    this.#tokenSource = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return this.#environment === null
      ? `github ${this.#repo} (repo secret)`
      : `github ${this.#repo} (secret of the environment ${this.#environment})`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#passed = false;
    const user = await this.#get("/user");
    if (user.status === 401)
      throw new Error(
        `GitHub refused the token for ${this.#login ?? "the active gh login"} (HTTP 401): the login expired or was revoked; run gh auth status to refresh it, or gh auth login --hostname github.com`,
      );
    if (user.status !== 200) throw this.#failure("GitHub GET /user", user);
    const publisher = stringField(user.body, "login");
    const scopes = user.headers.get("x-oauth-scopes");
    const expires = this.#expiry(user.headers);

    const repo = await this.#get(`/repos/${this.#repo}`);
    const facts = { publisher, expected: this.#owner, ...(expires ? { expires } : {}) };
    const sso = this.#ssoRefusal(repo);
    if (sso !== null) return { ...facts, destinationAccount: null, ok: false, ...sso };
    if (repo.status === 404) {
      return {
        ...facts,
        destinationAccount: null,
        ok: false,
        reason: `${publisher} can't see ${this.#repo}`,
        fix: `check repo in secretspec.toml, or publish as a login that can see it: git config github.account <login> (${NOT_ENTERPRISE})`,
      };
    }
    if (repo.status !== 200) throw this.#failure(`GitHub GET /repos/${this.#repo}`, repo);
    const owner = stringField(objectField(repo.body, "owner"), "login");
    const write = objectField(repo.body, "permissions").push === true;

    const refused = (refusal: Refusal): AccountCheck => ({
      ...facts,
      destinationAccount: owner,
      ok: false,
      ...refusal,
    });
    if (!sameLogin(owner, this.#owner))
      return refused({
        reason: `${this.#repo} is owned by ${owner}, not ${this.#owner} (moved or renamed?)`,
        fix: `if the repository moved, set repo to its current owner/name in secretspec.toml`,
      });
    if (this.#login !== null && !sameLogin(publisher, this.#login))
      return refused({
        reason: `the token acts as ${publisher}, not ${this.#login}`,
        fix: `run gh auth login --hostname github.com and sign in as ${this.#login}, or change git config github.account`,
      });
    if (repo.body.archived === true)
      return refused({
        reason: `${this.#repo} is archived, so it's read-only and GitHub won't let anyone set its secrets`,
        fix: `unarchive it in the repository's Settings, or remove it from secretspec.toml`,
      });
    if (!write)
      return refused({
        reason: `${publisher} has no write access to ${this.#repo}, so GitHub won't let it set Actions secrets`,
        fix: `ask an admin of ${this.#owner} for the Write role, or publish as another login: git config github.account <login>`,
      });
    if (scopes !== null && !scopes.split(",").some((s) => s.trim() === "repo"))
      return refused({
        reason: `the token lacks the repo scope (it has: ${scopes || "none"})`,
        fix:
          this.#login === null
            ? "run gh auth refresh --hostname github.com --scopes repo"
            : `run gh auth switch --hostname github.com --user ${this.#login}, then gh auth refresh --hostname github.com --scopes repo, then switch back to your usual login`,
      });
    const refusal = await this.#secretsRefusal(publisher);
    if (refusal !== null) return refused(refusal);
    this.#passed = true;
    return { ...facts, destinationAccount: owner, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    if (!this.#passed)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!SECRET_NAME.test(name) || /^GITHUB_/i.test(name))
      throw new Error(`"${name}" isn't a valid GitHub secret name`);
    const value = secret.reveal();

    const key = await this.#get(`${this.#secrets}/public-key`);
    if (key.status !== 200)
      throw this.#failure(`GitHub GET ${this.#secrets}/public-key`, key, [value]);
    const encrypted = await sealedBox(value, stringField(key.body, "key"));

    const path = `${this.#secrets}/${name}`;
    const put = await this.#request("PUT", path, {
      encrypted_value: encrypted,
      key_id: stringField(key.body, "key_id"),
    });
    if (put.status !== 201 && put.status !== 204) {
      const limit =
        put.status >= 400 && put.status < 500 && put.status !== 401 && put.status !== 403
          ? await this.#limitReached(name, Buffer.byteLength(value), path).catch(() => null)
          : null;
      if (limit !== null)
        throw new Error(`${limit} (GitHub PUT ${path} returned HTTP ${put.status})`);
      throw this.#failure(`GitHub PUT ${path}`, put, [value]);
    }

    const after = await this.#get(path);
    if (after.status !== 200)
      throw this.#failure(`GitHub GET ${path} after the write`, after, [value]);
    return {
      destination: this.describe(),
      secret: name,
      created: put.status === 201,
      updatedAt: stringField(after.body, "updated_at"),
    };
  }

  async #secretsRefusal(publisher: string): Promise<Refusal | null> {
    const path = `${this.#secrets}/public-key`;
    const key = await this.#get(path);
    if (key.status === 200) return null;
    const sso = this.#ssoRefusal(key);
    if (sso !== null) return sso;
    if (key.status === 404 && this.#environment !== null)
      return {
        reason: `${this.#repo} has no environment named ${this.#environment}, or ${publisher} can't see its secrets`,
        fix: `create it in the repository's Settings > Environments, or fix environment in secretspec.toml`,
      };
    if (key.status === 403 || key.status === 404)
      return {
        reason: `the token can't use ${this.#repo}'s Actions secrets (HTTP ${key.status}${gitHubSaid(key.body)})`,
        fix: `give the token the repository permission ${this.#environment === null ? "Secrets" : "Environments"}: Read and write, or sign gh in with the browser: gh auth login --hostname github.com`,
      };
    throw this.#failure(`GitHub GET ${path}`, key);
  }

  async #limitReached(name: string, bytes: number, path: string): Promise<string | null> {
    if (bytes > MAX_VALUE_BYTES)
      return `${name} is ${Math.ceil(bytes / 1024)} KB, and GitHub allows at most 48 KB in a secret`;
    if ((await this.#get(path)).status !== 404) return null;
    const total = (await this.#get(`${this.#secrets}?per_page=1`)).body.total_count;
    return typeof total === "number" && total >= MAX_SECRETS
      ? `${this.describe()} already has ${total} secrets, and GitHub allows ${MAX_SECRETS}; delete one it no longer uses, then publish again`
      : null;
  }

  #expiry(headers: Headers): Expiry | null {
    const at = expiryTime(headers.get("github-authentication-token-expiration"));
    if (at === null) return null;
    const who = this.#login ?? "the active gh login";
    return {
      credential: `the GitHub token for ${who}`,
      at,
      renew: `make a new token with the same access and sign gh in with it: gh auth login --hostname github.com --with-token < token.txt. In a workflow, replace the secret that holds it`,
    };
  }

  #ssoRefusal(reply: Reply): Refusal | null {
    const fix =
      reply.status === 403 || reply.status === 404 ? ssoFix(reply.headers, this.#owner) : null;
    return fix === null
      ? null
      : { reason: `the gh token isn't authorized for SAML SSO in ${this.#owner}`, fix };
  }

  #failure(what: string, reply: Reply, hide: readonly string[] = []): Error {
    const sso = ssoFix(reply.headers, this.#owner);
    const needs = reply.headers.get("x-accepted-github-permissions");
    const next = sso ? `; ${sso}` : needs ? `; the token needs the permission ${needs}` : "";
    return new Error(`${what} returned HTTP ${reply.status}${gitHubSaid(reply.body, hide)}${next}`);
  }

  #get(path: string) {
    return this.#request("GET", path);
  }

  async #request(method: string, path: string, body?: unknown): Promise<Reply> {
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

export function secretsPath(repo: string, environment?: string): string {
  return environment === undefined
    ? `/repos/${repo}/actions/secrets`
    : `/repos/${repo}/environments/${encodeURIComponent(environment)}/secrets`;
}

export async function sealedBox(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  return sodium.to_base64(sodium.crypto_box_seal(value, key), sodium.base64_variants.ORIGINAL);
}

const EXPIRATION = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (?:UTC|([+-]\d{2})(\d{2}))$/;

export function expiryTime(header: string | null): string | null {
  const [, day, time, hours, minutes] = EXPIRATION.exec(header?.trim() ?? "") ?? [];
  if (day === undefined || time === undefined) return null;
  const zone = hours === undefined ? "Z" : `${hours}:${minutes ?? "00"}`;
  const at = new Date(`${day}T${time}${zone}`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function stringField(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== "string") throw new Error(`GitHub's response has no "${field}"`);
  return value;
}
