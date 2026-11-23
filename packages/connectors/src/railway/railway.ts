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
import { TOKEN_VARIABLE, TOKENS_PAGE } from "./token";

const API = "https://backboard.railway.com/graphql/v2";
export const REDEPLOY =
  "Railway uses the new value only from the service's next deploy; deploy it to use it";

const PROJECT_TOKEN = "query { projectToken { projectId environmentId } }";
const ME = "query { me { email } }";
const PROJECT = `query project($id: String!) {
  project(id: $id) {
    environments { edges { node { id name canAccess } } }
    services { edges { node { id name } } }
  }
}`;
const UPSERT = `mutation variableUpsert($input: VariableUpsertInput!) {
  variableUpsert(input: $input)
}`;

export interface RailwayVariablesOptions {
  project: string;
  environment: string;
  service: string;
  token: () => Promise<string>;
  fetch?: Fetch;
}

type Reply = { status: number; data: Record<string, unknown>; errors: string[] };
type Header = "Project-Access-Token" | "Authorization";
type Place = { header: Header; environmentId: string; serviceId: string };
type Node = { id: string; name: string; canAccess?: unknown };

export class RailwayVariablesDestination implements Destination {
  readonly #project: string;
  readonly #environment: string;
  readonly #service: string;
  readonly #tokenSource: () => Promise<string>;
  readonly #fetch: Fetch;
  #token: Promise<string> | undefined;
  #place: Place | null = null;

  constructor(options: RailwayVariablesOptions) {
    this.#project = options.project;
    this.#environment = options.environment;
    this.#service = options.service;
    this.#tokenSource = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(): string {
    return `railway service ${this.#service} in project ${this.#project}, environment ${this.#environment} (service variable)`;
  }

  async checkAccount(): Promise<AccountCheck> {
    this.#place = null;
    const scoped = objectField(
      (await this.#request("Project-Access-Token", PROJECT_TOKEN)).data,
      "projectToken",
    );
    const projectToken = typeof scoped.projectId === "string" ? scoped : null;
    const header: Header = projectToken ? "Project-Access-Token" : "Authorization";
    const facts = { publisher: await this.#publisher(header), expected: this.#project };
    const fail = (reason: string, fix: string, account: string | null = null): AccountCheck => ({
      ...facts,
      destinationAccount: account,
      ok: false,
      reason,
      fix,
    });
    const tokenFix = `create a workspace token at ${TOKENS_PAGE} for the project's workspace, or a project token for environment ${this.#environment} in the project's settings, and set ${TOKEN_VARIABLE} to it`;

    if (projectToken && projectToken.projectId !== this.#project)
      return fail(
        `the project token is for another project, ${String(projectToken.projectId)}`,
        `check project in secretspec.toml, or ${tokenFix}`,
        String(projectToken.projectId),
      );

    const reply = await this.#request(header, PROJECT, { id: this.#project });
    if (reply.status !== 200) throw failure("project", reply);
    if (!isRecord(reply.data.project))
      return fail(
        `the token can't reach the project ${this.#project}`,
        `check project in secretspec.toml, or ${tokenFix}`,
      );
    const project = objectField(reply.data, "project");

    const environment = one(nodes(project.environments), this.#environment, "environment");
    if (typeof environment === "string")
      return fail(environment, "check environment in secretspec.toml");
    if (environment.canAccess === false)
      return fail(
        `the token can't reach the restricted environment ${this.#environment}`,
        tokenFix,
      );
    if (projectToken && projectToken.environmentId !== environment.id)
      return fail(
        `the project token is for another environment, not ${this.#environment}`,
        tokenFix,
      );

    const service = one(nodes(project.services), this.#service, "service");
    if (typeof service === "string") return fail(service, "check service in secretspec.toml");

    this.#place = { header, environmentId: environment.id, serviceId: service.id };
    return { ...facts, destinationAccount: this.#project, ok: true };
  }

  async write(name: string, secret: Secret): Promise<Evidence> {
    const place = this.#place;
    if (!place)
      throw new Error(`refusing to write to ${this.describe()}: checkAccount hasn't passed`);
    if (!name) throw new Error("a Railway variable needs a name");
    const sent = await this.#request(place.header, UPSERT, {
      input: {
        projectId: this.#project,
        environmentId: place.environmentId,
        serviceId: place.serviceId,
        name,
        value: secret.reveal(),
        skipDeploys: true,
      },
    });
    if (sent.status !== 200 || sent.errors.length || sent.data.variableUpsert !== true)
      throw failure("variableUpsert", sent, { echoesValue: true });
    return {
      destination: this.describe(),
      secret: name,
      environmentId: place.environmentId,
      serviceId: place.serviceId,
      deployed: false,
      note: REDEPLOY,
    };
  }

  async #publisher(header: Header): Promise<string> {
    if (header === "Project-Access-Token") return "a Railway project token";
    const email = objectField((await this.#request(header, ME)).data, "me").email;
    return typeof email === "string" ? email : "a Railway workspace token";
  }

  async #request(header: Header, query: string, variables: object = {}): Promise<Reply> {
    this.#token ??= this.#tokenSource();
    const token = await this.#token;
    const response = await this.#fetch(API, {
      method: "POST",
      headers: {
        ...(header === "Authorization"
          ? { Authorization: `Bearer ${token}` }
          : { "Project-Access-Token": token }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = parseObject(await response.text());
    const errors = (Array.isArray(body.errors) ? body.errors : [])
      .filter(isRecord)
      .map((e) => (typeof e.message === "string" ? e.message.trim() : ""))
      .filter((m) => m);
    return { status: response.status, data: objectField(body, "data"), errors };
  }
}

function nodes(connection: unknown): Node[] {
  const edges = isRecord(connection) && Array.isArray(connection.edges) ? connection.edges : [];
  return edges.filter(isRecord).flatMap((edge) => {
    const node = objectField(edge, "node");
    return typeof node.id === "string" && typeof node.name === "string"
      ? [{ id: node.id, name: node.name, canAccess: node.canAccess }]
      : [];
  });
}

function one(list: Node[], wanted: string, what: string): Node | string {
  const byId = list.find((item) => item.id === wanted);
  if (byId) return byId;
  const named = list.filter((item) => item.name === wanted);
  const [found, ...more] = named;
  if (!found) return `the project has no ${what} ${wanted}`;
  if (more.length) return `the project has ${named.length} ${what}s named ${wanted}; use its ID`;
  return found;
}

function failure(operation: string, reply: Reply, write = { echoesValue: false }): Error {
  const said = write.echoesValue ? [] : reply.errors;
  const where = `Railway ${operation} returned HTTP ${reply.status}`;
  const detail = said.length ? `, "${[...new Set(said)].join("; ")}"` : "";
  const why = explain(reply);
  return new Error(`${why ? `${why} (` : ""}${where}${detail}${why ? ")" : ""}`);
}

function explain(reply: Reply): string | null {
  if (reply.status === 429)
    return "Railway is rate-limiting the token; wait a few minutes and run it again";
  if (reply.status === 401 || reply.errors.includes("Not Authorized"))
    return `the token in ${TOKEN_VARIABLE} can't change this service's variables; use a workspace token for its workspace, or a project token for its environment (${TOKENS_PAGE})`;
  return null;
}
