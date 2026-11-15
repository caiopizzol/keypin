import { type Fetch, isRecord } from "@keypin/core";

export interface FakeCloudflare {
  email: string | null;
  accounts: Record<string, string[]>;
  failPut?: boolean;
}

const SCRIPT =
  /^\/client\/v4\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/(settings|secrets|versions)$/;

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
    if (init.method !== "PUT") return refuse(405, 10000, "Method not allowed");
    const sent: unknown = JSON.parse(init.body ?? "{}");
    const name = isRecord(sent) && typeof sent.name === "string" ? sent.name : "";
    const text = isRecord(sent) && typeof sent.text === "string" ? sent.text : "";
    if (fake.failPut) return refuse(500, 10013, `could not store ${text}`);
    stored.set(`${where} ${name}`, text);
    const list = versions.get(where) ?? [];
    list.push({
      id: `v-${list.length + 1}`,
      created_on: new Date(Date.UTC(2026, 10, 9, list.length)).toISOString(),
    });
    versions.set(where, list);
    effects.push(`cloudflare put ${where} ${name}`);
    return ok({ name, type: "secret_text" });
  };

  return {
    fetch,
    effects,
    value: (account: string, worker: string, name: string) =>
      stored.get(`${account}/${worker} ${name}`),
  };
}
