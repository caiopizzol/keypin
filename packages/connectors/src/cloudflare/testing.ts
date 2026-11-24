import { type Fetch, isRecord } from "@keypin/core";
import {
  API_TOKEN_VARIABLE,
  type CloudflareSignIn,
  CloudflareSignInFailed,
  FIRST_AUTH_TOKEN,
  type SignInProblem,
} from "./token";
import { INSTALL_IN_PROJECT } from "./find-wrangler";

export interface FakeCloudflare {
  email: string | null;
  accounts: Record<string, string[]>;
  failPut?: boolean;
}

const SCRIPT =
  /^\/client\/v4\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/(settings|secrets|secrets-bulk|versions)$/;

export function cloudflareFetch(fake: FakeCloudflare) {
  const stored = new Map<string, string>();
  const versions = new Map<string, { id: string; created_on: string }[]>();
  const effects: string[] = [];
  const ok = (result: unknown, extra: object = {}) =>
    new Response(JSON.stringify({ success: true, errors: [], result, ...extra }), { status: 200 });
  const refuse = (status: number, code: number, message: string) =>
    new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });

  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/client/v4/user")
      return fake.email === null
        ? refuse(403, 9109, "Unauthorized to access requested resource")
        : ok({ id: "fake-user", email: fake.email });
    if (path === "/client/v4/accounts")
      return ok(
        Object.keys(fake.accounts).map((id) => ({ id, name: id })),
        { result_info: { page: 1, total_pages: 1 } },
      );
    const [, account = "", worker = "", part] = SCRIPT.exec(path) ?? [];
    if (!fake.accounts[account]?.includes(worker))
      return refuse(404, 10007, "This Worker does not exist on your account.");
    const where = `${account}/${worker}`;
    if (part === "settings") return ok({ logpush: false });
    if (part === "versions")
      return ok({
        items: (versions.get(where) ?? []).map((v) => ({
          id: v.id,
          metadata: { created_on: v.created_on },
          annotations: { "workers/triggered_by": "secret" },
        })),
      });
    const bulk = part === "secrets-bulk";
    if (init.method !== (bulk ? "PATCH" : "PUT")) return refuse(405, 10000, "Method not allowed");
    const sent: unknown = JSON.parse(init.body ?? "{}");
    const list = bulk
      ? Object.values(isRecord(sent) && isRecord(sent.secrets) ? sent.secrets : {})
      : [sent];
    const secrets = list.flatMap((s) =>
      isRecord(s) && typeof s.name === "string" && typeof s.text === "string"
        ? [{ name: s.name, text: s.text }]
        : [],
    );
    if (fake.failPut) return refuse(500, 10013, `could not store ${secrets[0]?.text ?? ""}`);
    for (const { name, text } of secrets) stored.set(`${where} ${name}`, text);
    const name = secrets.map((s) => s.name).join(" ");
    const made = versions.get(where) ?? [];
    made.push({
      id: `v-${made.length + 1}`,
      created_on: new Date(Date.UTC(2026, 10, 9, made.length)).toISOString(),
    });
    versions.set(where, made);
    effects.push(`cloudflare put ${where} ${name}`);
    return ok(
      bulk
        ? Object.fromEntries(secrets.map((s) => [s.name, { name: s.name, type: "secret_text" }]))
        : { name, type: "secret_text" },
    );
  };

  return {
    fetch,
    effects,
    value: (account: string, worker: string, name: string) =>
      stored.get(`${account}/${worker} ${name}`),
  };
}

export function fakeSignIn(
  state: CloudflareSignIn["via"] | SignInProblem,
  token = "fake-worker-token",
): CloudflareSignIn {
  if (state === "oauth" || state === "api-token") return { via: state, token: async () => token };
  const messages: Record<SignInProblem, string> = {
    "no-wrangler": `keypin can't find wrangler in the project's node_modules or on PATH; install it ${INSTALL_IN_PROJECT.install} and run ${INSTALL_IN_PROJECT.login}, or set ${API_TOKEN_VARIABLE}`,
    "old-wrangler": `wrangler 4.20.0 can't give keypin its login; upgrade wrangler to ${FIRST_AUTH_TOKEN} or later`,
    "not-logged-in": `wrangler isn't signed in; run wrangler login, or set ${API_TOKEN_VARIABLE}`,
    failed:
      "wrangler couldn't give keypin its login; run wrangler auth token to see why, or wrangler login to sign in again",
  };
  return {
    via: "oauth",
    token: async () => {
      throw new CloudflareSignInFailed(messages[state], state);
    },
  };
}

export interface FakeToken {
  id: string;
  name: string;
  value: string;
  status?: "active" | "disabled" | "expired";
  policies: unknown[];
  condition?: Record<string, unknown>;
  not_before?: string;
  expires_on?: string;
  issued_on?: string;
}

export interface TokenWorld {
  tokens: FakeToken[];
  created: number;
}

export interface FakeTokens {
  admin: string;
  adminExpires?: string;
  account?: string;
  valuePrefix: string;
  issuedOn?: string;
  failCreate?: number;
  loseCreated?: boolean;
  world: { load(): TokenWorld; save(world: TokenWorld): void };
  effect(line: string): void;
}

const ISSUED_ON = "2026-11-17T12:00:00Z";

export function tokensFetch(fake: FakeTokens): Fetch {
  return async (url, init) => {
    const world = fake.world.load();
    const path = new URL(url).pathname;
    const reply = (status: number, result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status });
    const refuse = (status: number, code: number, message: string) =>
      new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), {
        status,
      });
    const bearer = (init.headers.Authorization ?? "").replace(/^Bearer /, "");
    const base =
      fake.account === undefined
        ? "/client/v4/user/tokens"
        : `/client/v4/accounts/${fake.account}/tokens`;
    if (path === `${base}/verify` && init.method === "GET") {
      if (bearer === fake.admin)
        return reply(200, {
          id: "ad".repeat(16),
          status: "active",
          ...(fake.adminExpires === undefined ? {} : { expires_on: fake.adminExpires }),
        });
      const token = world.tokens.find((t) => t.value === bearer);
      return token
        ? reply(200, { id: token.id, status: token.status ?? "active" })
        : refuse(401, 1000, "Invalid API Token");
    }
    if (bearer !== fake.admin) return refuse(401, 1000, "Invalid API Token");
    if (!path.startsWith(base))
      return refuse(403, 9109, "Unauthorized to access requested resource");
    const shown = ({ value: _value, ...token }: FakeToken) => ({
      status: "active",
      issued_on: ISSUED_ON,
      ...token,
    });
    if (path === base && init.method === "POST") {
      if (fake.failCreate !== undefined)
        return refuse(fake.failCreate, 1001, `refused ${init.headers.Authorization}`);
      const asked: unknown = JSON.parse(init.body ?? "{}");
      if (!isRecord(asked) || typeof asked.name !== "string" || asked.name.length > 120)
        return refuse(400, 1002, "invalid name");
      if (!Array.isArray(asked.policies) || !asked.policies.length)
        return refuse(400, 1002, "a token needs a policy");
      const made = world.created + 1;
      const token: FakeToken = {
        id: `${String(made).padStart(4, "0")}${"e".repeat(28)}`,
        name: asked.name,
        value: `${fake.valuePrefix}${made}_7d1e`,
        policies: asked.policies,
        issued_on: fake.issuedOn ?? ISSUED_ON,
        ...(isRecord(asked.condition) ? { condition: asked.condition } : {}),
        ...(typeof asked.not_before === "string" ? { not_before: asked.not_before } : {}),
        ...(typeof asked.expires_on === "string" ? { expires_on: asked.expires_on } : {}),
      };
      fake.world.save({ tokens: [...world.tokens, token], created: made });
      const limits = [
        ...(token.condition ? [`condition ${JSON.stringify(token.condition)}`] : []),
        ...(token.not_before ? [`not_before ${token.not_before}`] : []),
        ...(token.expires_on ? [`expires_on ${token.expires_on}`] : []),
      ];
      fake.effect(
        `cloudflare create token ${token.id} with ${JSON.stringify(token.policies)}${limits.length ? `, ${limits.join(", ")}` : ""}`,
      );
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(200, { ...shown(token), value: token.value });
    }
    const id = decodeURIComponent(path.slice(base.length + 1));
    const token = world.tokens.find((t) => t.id === id);
    if (!token) return refuse(404, 1003, "Token not found");
    if (init.method === "GET") return reply(200, shown(token));
    if (init.method !== "DELETE") return refuse(405, 10000, "Method not allowed");
    fake.world.save({ ...world, tokens: world.tokens.filter((t) => t.id !== id) });
    fake.effect(`cloudflare delete token ${id}`);
    return reply(200, { id });
  };
}

export function memoryTokens(tokens: FakeToken[]) {
  let world: TokenWorld = { tokens: [...tokens], created: 0 };
  return { load: () => world, save: (next: TokenWorld) => void (world = next) };
}
