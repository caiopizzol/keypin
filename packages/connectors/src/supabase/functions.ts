import {
  type AccountCheck,
  type Destination,
  type Evidence,
  type Fetch,
  isRecord,
  type Secret,
} from "@keypin/core";
import { type Reply, supabaseRequest, TOKEN_DOCS, TOKENS } from "./api";
import { TOKEN_VARIABLE } from "./token";

export const REF = /^[a-z]{20}$/;
export const LIVE = "Edge Functions read the new value at once, with no redeploy";
const RESERVED = "SUPABASE_";
const NAME_LIMIT = 256;
const VALUE_LIMIT = 24576;
const PERMISSION = "Edge Function Secrets Read-write";

export function refusedName(name: string): string | undefined {
  if (name.startsWith(RESERVED))
    return `Supabase reserves names that start with ${RESERVED} for the variables it sets itself`;
  if (name.length > NAME_LIMIT)
    return `Supabase takes secret names of up to ${NAME_LIMIT} characters`;
  return undefined;
}

export interface SupabaseSecretsOptions {
  projectRef: string;
  token: () => Promise<string>;
  fetch?: Fetch;
}

export class SupabaseSecretsDestination implements Destination {
  readonly #ref: string;
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #names = new Set<string>();
  #passed = false;

  constructor(options: SupabaseSecretsOptions) {
    if (!REF.test(options.projectRef))
      throw new Error(`"${options.projectRef}" isn't a Supabase project ref`);
    this.#ref = options.projectRef;
    this.#tokenSource = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `supabase project ${this.#ref} (Edge Function secrets)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#passed = false;
    this.#names = new Set();
    const facts = { publisher: await this.#publisher(), expected: this.#ref };
    const fail = (reason: string, fix: string): AccountCheck => ({
      ...facts,
      destinationAccount: null,
      ok: false,
      reason,
      fix,
    });
    const listed = await this.#request("GET", this.#secrets());
    if (listed.status === 401)
      return fail(
        "Supabase refused the token",
        `create a personal access token at ${TOKENS} and set ${TOKEN_VARIABLE} to it`,
      );
    if (listed.status === 403 || listed.status === 404)
      return fail(
        `the token can't read the Edge Function secrets of project ${this.#ref}`,
        `check project_ref in keypin.toml, or give the token ${PERMISSION} on the project; see ${TOKEN_DOCS}`,
      );
    if (listed.status !== 200 || !Array.isArray(listed.body))
      throw failure("GET", "/secrets", listed);
    const body: unknown[] = listed.body;
    for (const secret of body)
      if (isRecord(secret) && typeof secret.name === "string") this.#names.add(secret.name);
    this.#passed = true;
    return { ...facts, destinationAccount: this.#ref, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    if (!this.#passed)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!name) throw new Error("a Supabase secret needs a name");
    const refused = refusedName(name);
    if (refused) throw new Error(`keypin won't write ${name}: ${refused}`);
    if (secret.reveal().length > VALUE_LIMIT)
      throw new Error(
        `keypin won't write ${name}: Supabase takes secret values of up to ${VALUE_LIMIT} characters`,
      );
    const existed = this.#names.has(name);
    const sent = await this.#request("POST", this.#secrets(), [{ name, value: secret.reveal() }]);
    if (sent.status !== 200 && sent.status !== 201) throw failure("POST", "/secrets", sent);
    this.#names.add(name);
    return {
      destination: this.describe(),
      secret: name,
      action: existed ? "updated" : "created",
      note: LIVE,
    };
  }

  #secrets(): string {
    return `/projects/${encodeURIComponent(this.#ref)}/secrets`;
  }

  async #publisher(): Promise<string> {
    const reply = await this.#request("GET", "/profile");
    const profile = isRecord(reply.body) ? reply.body : {};
    const name = profile.username || profile.primary_email;
    return reply.status === 200 && typeof name === "string" && name
      ? name
      : "unknown (the token can't read its profile)";
  }

  async #request(method: string, path: string, body?: unknown): Promise<Reply> {
    this.#token ??= this.#tokenSource();
    return supabaseRequest(this.#fetch, await this.#token, method, path, body);
  }
}

function failure(method: string, path: string, reply: Reply): Error {
  const where = `Supabase ${method} ${path} returned HTTP ${reply.status}`;
  const why = explain(reply.status);
  return new Error(why ? `${why} (${where})` : where);
}

function explain(status: number): string | null {
  if (status === 401)
    return `Supabase refused the token in ${TOKEN_VARIABLE}: it's wrong, expired or deleted; create a new one at ${TOKENS}`;
  if (status === 403)
    return `the token can read the project's Edge Function secrets but not change them: give it ${PERMISSION}, from an account with the Owner or Administrator role; see ${TOKEN_DOCS}`;
  if (status === 429)
    return "Supabase is rate-limiting the token; wait a few minutes and run it again";
  return null;
}
