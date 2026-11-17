import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, parseMap, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { OpenAIIssuer, openaiIssuer } from "../../src/openai/index";
import {
  type FakeOpenAI,
  type FakeOpenAIKey,
  memoryKeys,
  openaiFetch,
  redacted,
} from "../../src/openai/testing";

const ADMIN = "sk-admin-sentinel-5c1f";
const PREFIX = "sk-svcacct-issued-sentinel-";
const VAULT = "sk-svcacct-vault-sentinel-2f4b";
const BOT = { type: "service_account", id: "svc_bot", name: "billing-bot" } as const;
const OLD: FakeOpenAIKey = { id: "key_old", name: "prod", value: VAULT, owner: BOT };

function openai(
  keys: FakeOpenAIKey[] = [OLD],
  options: Partial<FakeOpenAI> = {},
  scopes: readonly string[] = [],
) {
  const effects: string[] = [];
  const requests: { method: string; path: string; body: string }[] = [];
  const store = memoryKeys(keys);
  const fake: FakeOpenAI = {
    admin: ADMIN,
    projectId: "proj_1",
    projectName: "billing",
    tokenPrefix: PREFIX,
    keys: store,
    effect: (line) => void effects.push(line),
    ...options,
  };
  const served = openaiFetch(fake);
  const fetch: Fetch = (url, init) => {
    const { pathname, search } = new URL(url);
    requests.push({ method: init.method, path: `${pathname}${search}`, body: init.body ?? "" });
    return served(url, init);
  };
  const issuer = new OpenAIIssuer({
    admin: async () => new Secret(ADMIN),
    projectId: "proj_1",
    scopes,
    fetch,
  });
  return { issuer, effects, requests, store, fake };
}

function answering(status: number, body: object = {}): Fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

const withFetch = (fetch: Fetch) =>
  new OpenAIIssuer({
    admin: async () => new Secret(ADMIN),
    projectId: "proj_1",
    scopes: [],
    fetch,
  });

function expectNoSecret(...seen: unknown[]) {
  const text = JSON.stringify(
    seen.map((s) => (s instanceof Error ? `${s.message} ${s.stack}` : s)),
  );
  for (const secret of [ADMIN, PREFIX, VAULT]) expect(text).not.toContain(secret);
}

describe("checkAccount", () => {
  test("finds the vault's key by its redacted value and names its service account", async () => {
    const { issuer, requests } = openai([
      { id: "key_other", name: "dev", value: "sk-svcacct-another-key-91aa", owner: BOT },
      OLD,
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.currentId).toBe("svc_bot/key_old");
    expect(check.facts).toBe(
      "project billing lists 2 API keys; the vault holds key_old of service account billing-bot",
    );
    expect(check.notes?.create).toBe("for service account billing-bot, with all permissions");
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/organization/projects/proj_1",
      "GET /v1/organization/projects/proj_1/api_keys?limit=100&owner_project_access=any",
    ]);
    expectNoSecret(check);
  });

  test("a user-owned vault key is refused: the Admin API makes keys only for service accounts", async () => {
    const { issuer, effects } = openai([
      { ...OLD, owner: { type: "user", id: "user_1", name: "Ada" } },
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "key key_old belongs to a user, and OpenAI's Admin API makes keys only for service accounts",
    );
    expect(check.fix).toContain("owned by a service account");
    await expect(issuer.create("x")).rejects.toBeInstanceOf(NothingChanged);
    expect(effects).toEqual([]);
  });

  test("a vault key the project doesn't list is refused", async () => {
    const { issuer } = openai([
      { id: "key_other", name: "dev", value: "sk-svcacct-another-key-91aa", owner: BOT },
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("no key in project billing matches the vault's key");
  });

  test("two keys that start and end like the vault's key are refused, naming both", async () => {
    const { issuer } = openai([
      OLD,
      { id: "key_twin", name: "twin", value: "sk-svcacct-other-middle-2f4b", owner: BOT },
    ]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toContain("2 keys in project billing start and end like the vault's key");
    expect(check.reason).toContain("key_old, key_twin");
  });

  test("reads every page of keys", async () => {
    const many = Array.from({ length: 4 }, (_, n) => ({
      ...OLD,
      id: `key_${n}`,
      value: `sk-svcacct-filler-${n}-aaaa`,
    }));
    const { issuer, requests } = openai([...many, OLD], { pageSize: 2 });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.facts).toContain("lists 5 API keys");
    expect(requests.filter((r) => r.path.includes("/api_keys")).map((r) => r.path)).toEqual([
      "/v1/organization/projects/proj_1/api_keys?limit=100&owner_project_access=any",
      "/v1/organization/projects/proj_1/api_keys?limit=100&owner_project_access=any&after=key_1",
      "/v1/organization/projects/proj_1/api_keys?limit=100&owner_project_access=any&after=key_3",
    ]);
  });

  test("the key keypin issued last time must be listed, or OpenAI must refuse the vault's key", async () => {
    const { issuer } = openai();
    const check = await issuer.checkAccount("svc_bot/key_gone", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "project billing doesn't list key key_gone, the one keypin issued last time, but OpenAI still accepts the vault's key",
    );
  });

  test("the key keypin issued, missing and refused for the vault, was deleted; create uses its service account", async () => {
    const { issuer, effects } = openai([], { serviceAccounts: [BOT] });
    const check = await issuer.checkAccount("svc_bot/key_gone", new Secret(VAULT));
    assert(check.ok);
    expect(check.gone).toBe("key key_gone was deleted at OpenAI");
    const created = await issuer.create("API_KEY prod");
    expect(created.id).toBe("svc_bot/key_new1");
    expect(effects).toEqual(["openai create key_new1 for svc_bot"]);
  });

  test("an ID keypin didn't write is refused", async () => {
    const { issuer } = openai();
    const check = await issuer.checkAccount("key_old", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe("key_old, the key keypin issued last time, isn't an OpenAI key ID");
  });

  test("an admin key OpenAI doesn't accept", async () => {
    const check = await withFetch(
      answering(401, { error: { code: "invalid_api_key", message: `bad ${ADMIN}` } }),
    ).checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toBe("OpenAI answered HTTP 401 invalid_api_key");
    expect(check.reason).toContain("it isn't an Admin key");
    expectNoSecret(check);
  });

  test("an admin key without access to the project", async () => {
    const check = await withFetch(answering(403)).checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe("the admin key can't manage the keys of project proj_1");
  });

  test("a project the organization doesn't have", async () => {
    const { issuer } = openai([OLD], { projectId: "proj_2" });
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe("the admin key's organization has no project proj_1");
    expect(check.fix).toContain("project_id");
  });

  test("a server error throws, without the admin key", async () => {
    const failed = await withFetch(
      answering(500, { error: { type: "server_error", message: ADMIN } }),
    )
      .checkAccount(null, new Secret(VAULT))
      .catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed.message).toBe(
      "OpenAI GET /organization/projects/<project_id> returned HTTP 500 server_error",
    );
    expectNoSecret(failed);
  });
});

describe("create", () => {
  test("makes a key for the old key's service account, with the map's scopes", async () => {
    const { issuer, requests, effects } = openai([OLD], {}, ["api.responses.write"]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toBe(
      "for service account billing-bot, with scopes api.responses.write",
    );
    const created = await issuer.create("OPENAI_API_KEY prod");
    expect(created.id).toBe("svc_bot/key_new1");
    expect(created.secret.includes(PREFIX)).toBe(true);
    const post = requests.at(-1);
    expect(post?.path).toBe("/v1/organization/projects/proj_1/service_accounts/svc_bot/api_keys");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      name: "OPENAI_API_KEY prod",
      scopes: ["api.responses.write"],
    });
    expect(effects).toEqual(["openai create key_new1 for svc_bot with scopes api.responses.write"]);
    expectNoSecret(created.id, check, effects);
  });

  test("keeps the old key's lifetime when it expires", async () => {
    const { issuer, effects } = openai([{ ...OLD, lifetime: 90 * 86_400 }]);
    const check = await issuer.checkAccount(null, new Secret(VAULT));
    assert(check.ok);
    expect(check.notes?.create).toBe(
      "for service account billing-bot, with all permissions, expiring in 90 days",
    );
    await issuer.create("x");
    expect(effects).toEqual([`openai create key_new1 for svc_bot with expiring in 7776000s`]);
  });

  test("an admin key that can read but not write projects changes nothing", async () => {
    let posted = false;
    const { fake } = openai();
    const served = openaiFetch(fake);
    const issuer = withFetch(async (url, init) => {
      if (init.method !== "POST") return served(url, init);
      posted = true;
      return new Response(JSON.stringify({ error: { message: "insufficient permissions" } }), {
        status: 403,
      });
    });
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.create("x").catch((error: unknown) => error);
    expect(posted).toBe(true);
    assert(failed instanceof NothingChanged);
    expect(failed.message).toContain("give it write access to projects");
  });

  test("a client error is NothingChanged; a server error may have made the key", async () => {
    for (const [status, type] of [
      [400, NothingChanged],
      [500, Error],
    ] as const) {
      const { issuer, fake } = openai();
      await issuer.checkAccount(null, new Secret(VAULT));
      fake.failCreate = status;
      const failed = await issuer.create("x").catch((error: unknown) => error);
      assert(failed instanceof type);
      expect(failed instanceof NothingChanged).toBe(status === 400);
      expectNoSecret(failed);
    }
  });

  test("a reply without an id and value throws, and isn't counted as nothing created", async () => {
    const { fake } = openai();
    const served = openaiFetch(fake);
    const issuer = withFetch(async (url, init) =>
      init.method === "POST"
        ? new Response(JSON.stringify({ id: "key_new1" }), { status: 200 })
        : served(url, init),
    );
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.create("x").catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed instanceof NothingChanged).toBe(false);
    expect(failed.message).toContain("has no id and value");
  });

  test("a lost reply names the key and the project to look in", async () => {
    const { issuer, fake, effects } = openai();
    await issuer.checkAccount(null, new Secret(VAULT));
    fake.loseCreated = true;
    await expect(issuer.create("OPENAI_API_KEY prod")).rejects.toThrow("fetch failed");
    expect(effects).toEqual(["openai create key_new1 for svc_bot"]);
    expect(issuer.lostCreate("OPENAI_API_KEY prod")).toBe(
      'OpenAI may have made the key before the reply was lost. Only this run uses the name "OPENAI_API_KEY prod": delete a key with that name in project billing at https://platform.openai.com/settings/organization/api-keys before you run this again, or the rerun leaves it live.',
    );
  });
});

describe("revoke", () => {
  test("deletes the project key by its ID", async () => {
    const { issuer, requests, effects } = openai();
    await issuer.checkAccount(null, new Secret(VAULT));
    expect(await issuer.revoke("svc_bot/key_old")).toBe("revoked");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/v1/organization/projects/proj_1/api_keys/key_old",
    });
    expect(effects).toEqual(["openai revoke key_old"]);
    expect(await issuer.revoke("svc_bot/key_old")).toBe("already gone");
  });

  test("the id is one path segment", async () => {
    const { issuer, requests } = openai();
    await issuer.checkAccount(null, new Secret(VAULT));
    expect(await issuer.revoke("svc_bot/key/../x")).toBe("already gone");
    expect(requests.at(-1)?.path).toBe("/v1/organization/projects/proj_1/api_keys/key%2F..%2Fx");
  });

  test("an admin key that can't delete says where to delete it", async () => {
    const { fake } = openai();
    const served = openaiFetch(fake);
    const issuer = withFetch(async (url, init) =>
      init.method === "DELETE" ? new Response("{}", { status: 403 }) : served(url, init),
    );
    await issuer.checkAccount(null, new Secret(VAULT));
    await expect(issuer.revoke("svc_bot/key_old")).rejects.toThrow(
      "or delete key key_old at https://platform.openai.com/settings/organization/api-keys",
    );
  });

  test("another failure throws, without the admin key", async () => {
    const { fake } = openai();
    const served = openaiFetch(fake);
    const issuer = withFetch(async (url, init) =>
      init.method === "DELETE"
        ? new Response(JSON.stringify({ error: { message: ADMIN } }), { status: 500 })
        : served(url, init),
    );
    await issuer.checkAccount(null, new Secret(VAULT));
    const failed = await issuer.revoke("svc_bot/key_old").catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed.message).toBe(
      "OpenAI DELETE /organization/projects/<project_id>/api_keys/<id> returned HTTP 500",
    );
    expectNoSecret(failed);
  });
});

describe("the fake's redacted value", () => {
  test("keeps the prefix and the last four characters, as OpenAI does", () => {
    expect(redacted("sk-proj-abcdefgh1234")).toBe("sk-proj-********1234");
    expect(redacted("sk-svcacct-abcdefgh1234")).toBe("sk-svcacct-********1234");
  });
});

describe("the issuer table", () => {
  const map = (fields: string) => `
[1password]
account = "my.1password.com"

[keys.OPENAI_API_KEY.prod]
from = "op://Private/openai key/credential"
issuer = { kind = "openai", admin = "op://Private/openai admin key/credential", ${fields} }
`;
  const parse = (fields: string) =>
    parseMap(map(fields), "/w/keypin.toml", [], [openaiIssuer], [onePasswordVault]);

  test("reads project_id and scopes", () => {
    const parsed = parse(`project_id = "proj_1", scopes = ["api.responses.write"]`);
    assert(parsed.ok);
    expect(parsed.map.keys[0]?.environments.prod?.issuer).toMatchObject({
      kind: "openai",
      projectId: "proj_1",
      scopes: ["api.responses.write"],
    });
  });

  test("an empty scopes list means all permissions", () => {
    const parsed = parse(`project_id = "proj_1", scopes = []`);
    assert(parsed.ok);
    expect(parsed.map.keys[0]?.environments.prod?.issuer).toMatchObject({ scopes: [] });
  });

  test("project_id and scopes are required, and a placeholder isn't a project", () => {
    for (const [fields, error] of [
      [`scopes = []`, `missing field "project_id"`],
      [`project_id = "proj_1"`, `missing field "scopes"`],
      [`project_id = "<project id>", scopes = []`, `field "project_id" is a <...> placeholder`],
      [`project_id = "proj_1", scopes = [], role = "x"`, `unknown field "role" for openai`],
    ] as const) {
      const parsed = parse(fields);
      assert(!parsed.ok);
      expect(parsed.errors.join("\n")).toContain(error);
    }
  });
});
