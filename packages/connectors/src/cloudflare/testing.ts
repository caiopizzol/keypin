import { type Fetch, isRecord } from "@keypin/core";
import {
  API_TOKEN_VARIABLE,
  type CloudflareSignIn,
  CloudflareSignInFailed,
  FIRST_AUTH_TOKEN,
  type SignInProblem,
} from "./token";

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
    "no-wrangler": `keypin can't find wrangler in the project's node_modules or on PATH; install it and run wrangler login, or set ${API_TOKEN_VARIABLE}`,
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
