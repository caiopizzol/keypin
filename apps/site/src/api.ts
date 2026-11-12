import type { Answers, Auth, SignupStore, TeamSize } from "./signup";

export interface Api {
  publishableKey: string;
  siteOrigin: string;
  auth: Auth;
  store: SignupStore;
  now(): string;
  log(message: string, cause: unknown): void;
}

export const API_PATHS = ["/api/config", "/api/signup"];
const MAX_BODY = 4096;
const MAX_NOTE = 500;
const TEAM_SIZES: readonly string[] = ["2-10", "11-50", "51+"] satisfies TeamSize[];
const FIELDS = new Set(["use", "teamSize", "note"]);

function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function error(status: number, message: string, headers?: Record<string, string>): Response {
  return json(status, { error: message }, headers);
}

function isTeamSize(value: unknown): value is TeamSize {
  return typeof value === "string" && TEAM_SIZES.includes(value);
}

export function parseAnswers(body: unknown): Answers | string {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return "Send a JSON object.";
  const unknown = Object.keys(body).filter((key) => !FIELDS.has(key));
  if (unknown.length > 0) return `Unknown field: ${unknown.join(", ")}.`;
  const fields: { use?: unknown; teamSize?: unknown; note?: unknown } = body;
  let teamSize: TeamSize | null = null;
  if (fields.use === "team") {
    if (!isTeamSize(fields.teamSize)) return 'Give "teamSize" as "2-10", "11-50" or "51+".';
    teamSize = fields.teamSize;
  } else if (fields.use === "solo") {
    if ("teamSize" in fields) return 'Leave out "teamSize" when "use" is "solo".';
  } else {
    return 'Give "use" as "solo" or "team".';
  }
  if (fields.note !== undefined && typeof fields.note !== "string") return '"note" must be text.';
  const note = fields.note?.trim() ?? "";
  if (note.length > MAX_NOTE) return `Keep "note" to ${MAX_NOTE} characters.`;
  return { use: fields.use, teamSize, note: note === "" ? null : note };
}

async function readAnswers(request: Request): Promise<Answers | Response> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
    return error(413, "The request body is over 4 KB.");
  const bytes = await readLimited(request);
  if (!bytes) return error(413, "The request body is over 4 KB.");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, "The request body isn't valid JSON.");
  }
  const answers = parseAnswers(body);
  return typeof answers === "string" ? error(400, answers) : answers;
}

async function readLimited(request: Request): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (let next = await reader?.read(); next && !next.done; next = await reader?.read()) {
    size += next.value.byteLength;
    if (size > MAX_BODY) {
      await reader?.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

async function signup(request: Request, api: Api): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "PUT" && method !== "DELETE")
    return error(405, "Use GET, PUT or DELETE.", { allow: "GET, PUT, DELETE" });
  if (method !== "GET" && request.headers.get("origin") !== api.siteOrigin)
    return error(403, `Send this request from ${api.siteOrigin}.`);
  const token = bearer(request);
  const userId = token ? await api.auth.verify(token) : null;
  if (!userId) return error(401, "Sign in with GitHub first.");

  if (method === "GET") return json(200, { signup: await api.store.get(userId) });
  if (method === "DELETE") {
    await api.store.delete(userId);
    return json(204);
  }
  const answers = await readAnswers(request);
  if (answers instanceof Response) return answers;
  const profile = await api.auth.profile(userId);
  return json(200, { signup: await api.store.put(userId, profile, answers, api.now()) });
}

export async function handleApi(request: Request, api: Api): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/config") {
    if (request.method !== "GET") return error(405, "Use GET.", { allow: "GET" });
    return json(200, { clerkPublishableKey: api.publishableKey });
  }
  try {
    return await signup(request, api);
  } catch (cause) {
    api.log("/api/signup failed", cause);
    return error(500, "Something went wrong on our side. Try again.");
  }
}
