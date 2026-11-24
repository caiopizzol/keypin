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
import { NAME, STANDARD } from "./rules";
import { TOKEN_VARIABLE, TOKENS_PAGE } from "./token";

const API = "https://api.vercel.com";
export const REDEPLOY = "Vercel uses the new value only in new deployments; redeploy to use it";
const SECRET = { type: "sensitive", visibility: "secret" };

interface VercelEnvOptions {
  team: string;
  project: string;
  environment: string;
  token: () => Promise<string>;
  fetch?: Fetch;
}

type Reply = { status: number; body: Record<string, unknown> };

export class VercelEnvDestination implements Destination {
  readonly #team: string;
  readonly #project: string;
  readonly #environment: string;
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #customId: string | null = null;
  #passed = false;

  constructor(options: VercelEnvOptions) {
    for (const what of ["team", "project", "environment"] as const)
      if (!NAME.test(options[what])) throw new Error(`"${options[what]}" isn't a Vercel ${what}`);
    this.#team = options.team;
    this.#project = options.project;
    this.#environment = options.environment;
    this.#tokenSource = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `vercel project ${this.#project} in team ${this.#team}, environment ${this.#environment} (sensitive variable)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#passed = false;
    this.#customId = null;
    const facts = { publisher: await this.#publisher(), expected: this.#team };
    const fail = (reason: string, fix: string): AccountCheck => ({
      ...facts,
      destinationAccount: null,
      ok: false,
      reason,
      fix,
    });
    const tokenFix = `create a token at ${TOKENS_PAGE} for team ${this.#team} or for the project, and set ${TOKEN_VARIABLE} to it`;

    const project = await this.#request("GET", this.#path(""));
    if (refusedToken(project)) return fail("Vercel refused the token", tokenFix);
    if (project.status === 403 || project.status === 404)
      return fail(
        `the token can't reach the project ${this.#project} in team ${this.#team}`,
        `check team and project in secretspec.toml, or ${tokenFix}`,
      );
    if (project.status !== 200) throw failure("GET", "/v9/projects", project);

    if (!STANDARD.includes(this.#environment)) {
      const listed = await this.#request("GET", this.#path("/custom-environments"));
      if (listed.status !== 200) throw failure("GET", "/v9/projects/custom-environments", listed);
      const found = (Array.isArray(listed.body.environments) ? listed.body.environments : [])
        .filter(isRecord)
        .find((e) => e.slug === this.#environment || e.id === this.#environment);
      if (typeof found?.id !== "string")
        return fail(
          `the project ${this.#project} has no environment ${this.#environment}`,
          `create the custom environment in Vercel first, or set environment to ${STANDARD.join(", ")}`,
        );
      this.#customId = found.id;
    }

    this.#passed = true;
    return { ...facts, destinationAccount: this.#team, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    if (!this.#passed)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!name) throw new Error("a Vercel environment variable needs a name");
    const existing = await this.#existing(name);
    const hidden = async () => [secret.reveal(), await this.#tokenOrEmpty()];
    let id = existing;
    if (existing !== null) {
      const path = this.#path(`/env/${encodeURIComponent(existing)}`);
      const sent = await this.#request("PATCH", path, { value: secret.reveal(), ...SECRET });
      if (sent.status !== 200) throw failure("PATCH", "/v9/projects/env", sent, await hidden());
    } else {
      const sent = await this.#request("POST", this.#path("/env", "v10"), {
        key: name,
        value: secret.reveal(),
        ...SECRET,
        ...(this.#customId === null
          ? { target: [this.#environment] }
          : { customEnvironmentIds: [this.#customId] }),
      });
      const failed = Array.isArray(sent.body.failed) && sent.body.failed.length > 0;
      if ((sent.status !== 200 && sent.status !== 201) || failed)
        throw failure("POST", "/v10/projects/env", sent, await hidden());
      const created = objectField(sent.body, "created").id;
      id = typeof created === "string" ? created : null;
    }
    return {
      destination: this.describe(),
      secret: name,
      variableId: id,
      action: existing === null ? "created" : "updated",
      type: "sensitive",
      note: REDEPLOY,
    };
  }

  async #existing(name: string): Promise<string | null> {
    const envs: unknown[] = [];
    let until: string | null = null;
    do {
      const page = until === null ? "" : `&until=${encodeURIComponent(until)}`;
      const listed = await this.#request("GET", `${this.#path("/env", "v10")}${page}`);
      if (listed.status !== 200) throw failure("GET", "/v10/projects/env", listed);
      if (!Array.isArray(listed.body.envs))
        throw new Error("Vercel's environment variable list has no envs");
      const listedEnvs: unknown[] = listed.body.envs;
      envs.push(...listedEnvs);
      const next = objectField(listed.body, "pagination").next;
      until = typeof next === "number" || typeof next === "string" ? String(next) : null;
    } while (until !== null);
    const mine = envs.filter(isRecord).filter((env) => {
      if (env.key !== name || (typeof env.gitBranch === "string" && env.gitBranch)) return false;
      return this.#customId === null
        ? strings(env.target).includes(this.#environment)
        : strings(env.customEnvironmentIds).includes(this.#customId);
    });
    const [found, ...more] = mine;
    if (!found) return null;
    if (more.length)
      throw new Error(
        `the project ${this.#project} has ${mine.length} variables named ${name} for ${this.#environment}; delete all but one in Vercel, then publish again`,
      );
    if (found.type === "system")
      throw new Error(`${name} is a Vercel system environment variable; keypin doesn't write it`);
    const others = [
      ...strings(found.target).filter((t) => t !== this.#environment),
      ...strings(found.customEnvironmentIds).filter((c) => c !== this.#customId),
    ];
    if (others.length)
      throw new Error(
        `${name} in the project ${this.#project} is one variable for ${this.#environment} and ${others.join(", ")}, so writing it would change those too; keypin writes one variable per environment. In Vercel, remove the other environments from it, or delete it, then publish again`,
      );
    if (typeof found.id !== "string" || !found.id)
      throw new Error(`Vercel listed ${name} without an ID`);
    return found.id;
  }

  #path(rest: string, version = "v9"): string {
    const scope = this.#team.startsWith("team_") ? "teamId" : "slug";
    return `/${version}/projects/${encodeURIComponent(this.#project)}${rest}?${scope}=${encodeURIComponent(this.#team)}`;
  }

  async #publisher(): Promise<string> {
    const reply = await this.#request("GET", "/v2/user");
    const user = objectField(reply.body, "user");
    const name = user.username ?? user.email;
    return reply.status === 200 && typeof name === "string"
      ? name
      : "unknown (the token can't read its user)";
  }

  async #tokenOrEmpty(): Promise<string> {
    return this.#token ? await this.#token.catch(() => "") : "";
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

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function refusedToken(reply: Reply): boolean {
  return reply.status === 401 || objectField(reply.body, "error").invalidToken === true;
}

function failure(
  method: string,
  path: string,
  reply: Reply,
  hidden: readonly string[] = [],
): Error {
  const errors = [
    objectField(reply.body, "error"),
    ...(Array.isArray(reply.body.failed)
      ? reply.body.failed.filter(isRecord).map((f) => objectField(f, "error"))
      : []),
  ];
  const secrets = hidden.flatMap((h) => [h, h.trim()]).filter((h) => h);
  const said = errors
    .flatMap((e) => [e.code, e.message])
    .map((m) => (typeof m === "string" ? m.trim() : ""))
    .filter((m) => m && !secrets.some((h) => m.includes(h)));
  const where = `Vercel ${method} ${path} returned HTTP ${reply.status}`;
  const detail = said.length ? `, "${[...new Set(said)].join("; ")}"` : "";
  const why = explain(reply);
  return new Error(`${why ? `${why} (` : ""}${where}${detail}${why ? ")" : ""}`);
}

function explain(reply: Reply): string | null {
  if (refusedToken(reply))
    return `Vercel refused the token in ${TOKEN_VARIABLE}: it's wrong, expired or deleted; create a new one at ${TOKENS_PAGE}`;
  if (reply.status === 403)
    return "the token can't change this project's environment variables; use a token for its team or project";
  if (reply.status === 429)
    return "Vercel is rate-limiting the token; wait a few minutes and run it again";
  return null;
}
