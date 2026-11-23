import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, readSecretspec, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { TwilioIssuer, twilioIssuer } from "../../src/twilio/index";
import {
  adminJson,
  type FakeTwilio,
  type FakeTwilioKey,
  memoryWorld,
  twilioFetch,
} from "../../src/twilio/testing";

const ACCOUNT = `AC${"a".repeat(32)}`;
const OTHER_ACCOUNT = `AC${"b".repeat(32)}`;
const TOKEN = "auth-token-0001";
const APP_SID = `SK${"1".repeat(32)}`;
const APP_SECRET = "app-secret-0001";
const ADMIN_SID = `SK${"2".repeat(32)}`;
const ADMIN_SECRET = "admin-secret-0001";
const NEW_SID = `SKe${"0".repeat(30)}1`;
const MANAGE = [
  "/twilio/iam/api-keys/create",
  "/twilio/iam/api-keys/read",
  "/twilio/iam/api-keys/delete",
];
const APP: FakeTwilioKey = { sid: APP_SID, secret: APP_SECRET, name: "app", type: "standard" };
const TOKEN_ADMIN = adminJson({ TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN });
const KEY_ADMIN = adminJson({
  TWILIO_ACCOUNT_SID: ACCOUNT,
  TWILIO_API_KEY: ADMIN_SID,
  TWILIO_API_SECRET: ADMIN_SECRET,
});
const adminKey = (type: FakeTwilioKey["type"], policy?: string[]): FakeTwilioKey => ({
  sid: ADMIN_SID,
  secret: ADMIN_SECRET,
  name: "keypin admin",
  type,
  ...(policy === undefined ? {} : { policy }),
});

function twilio(
  keys: FakeTwilioKey[] = [APP],
  admin = TOKEN_ADMIN,
  options: Partial<FakeTwilio> = {},
) {
  const effects: string[] = [];
  const calls: { method: string; path: string; user: string; body: string }[] = [];
  const world = memoryWorld(keys);
  const fake: FakeTwilio = {
    account: ACCOUNT,
    authToken: TOKEN,
    sidPrefix: "SKe",
    valuePrefix: "new-secret-",
    world,
    effect: (line) => void effects.push(line),
    ...options,
  };
  const inner = twilioFetch(fake);
  const fetch: Fetch = (url, init) => {
    const { pathname, search } = new URL(url);
    const basic = (init.headers.Authorization ?? "").replace(/^Basic /, "");
    calls.push({
      method: init.method,
      path: `${pathname}${search}`,
      user: atob(basic).split(":")[0] ?? "",
      body: init.body ?? "",
    });
    return inner(url, init);
  };
  const issuer = new TwilioIssuer({ admin: async () => new Secret(admin), fetch });
  return { issuer, fake, world, effects, calls };
}

async function checked(subject: ReturnType<typeof twilio>, id = APP_SID, secret = APP_SECRET) {
  const check = await subject.issuer.checkAccount(id, new Secret(secret));
  assert(check.ok, JSON.stringify(check));
  return check;
}

async function refused(subject: ReturnType<typeof twilio>, id = APP_SID, secret = APP_SECRET) {
  const check = await subject.issuer.checkAccount(id, new Secret(secret));
  assert(!check.ok, JSON.stringify(check));
  return check;
}

describe("Twilio issuer", () => {
  test("checks the vault's pair, then makes a Standard key in the same account", async () => {
    const subject = twilio();
    const check = await checked(subject);
    expect(check.facts).toBe(`the vault holds API key ${APP_SID} "app" of account ${ACCOUNT}`);
    expect(check.currentId).toBe(APP_SID);
    expect(check.notes?.create).toBe("a Standard key, like the old one");
    const created = await subject.issuer.create("TWILIO_API_SECRET prod 2026-11-18 12:00:00 ab12");
    expect(created.id).toBe(NEW_SID);
    expect(created.secret.equals(new Secret("new-secret-1x"))).toBe(true);
    expect(subject.calls.map((c) => `${c.user} ${c.method} ${c.path}`)).toEqual([
      `${ACCOUNT} GET /v1/Keys/${APP_SID}`,
      `${APP_SID} GET /2010-04-01/Accounts/${ACCOUNT}/AvailablePhoneNumbers.json`,
      `${APP_SID} GET /v1/Keys?AccountSid=${ACCOUNT}&PageSize=1`,
      `${ACCOUNT} POST /v1/Keys`,
    ]);
    expect(Object.fromEntries(new URLSearchParams(subject.calls.at(-1)?.body))).toEqual({
      AccountSid: ACCOUNT,
      FriendlyName: "TWILIO_API_SECRET prod 2026-11-18 12:00:00 ab12",
    });
    expect(subject.effects).toEqual([`twilio create ${NEW_SID} standard`]);
  });

  test("gives a Restricted key's permissions to the new key", async () => {
    const allow = [
      "/twilio/messaging/messages/create",
      "/twilio/phone-numbers/available-numbers/list",
    ];
    const subject = twilio([{ ...APP, type: "restricted", policy: allow }]);
    const check = await checked(subject);
    expect(check.facts).toContain("the vault holds Restricted key");
    expect(check.notes?.create).toBe("a Restricted key with the old key's 2 permissions");
    await subject.issuer.create("app");
    const form = new URLSearchParams(subject.calls.at(-1)?.body);
    expect(form.get("KeyType")).toBe("restricted");
    expect(JSON.parse(form.get("Policy") ?? "")).toEqual({ allow });
    expect(subject.calls.some((c) => c.path.startsWith("/v1/Keys?"))).toBe(false);
  });

  test("a Restricted key Twilio answers 70051 for is refused, and create and revoke stay gated", async () => {
    const subject = twilio([
      { ...APP, type: "restricted", policy: ["/twilio/messaging/messages/create"] },
    ]);
    const check = await subject.issuer.checkAccount(APP_SID, new Secret(APP_SECRET));
    assert(!check.ok);
    expect(check.reason).toContain("keypin can't confirm the vault's secret works");
    expect(check.reason).toContain("suspended");
    await expect(subject.issuer.create("app")).rejects.toThrow("checkAccount hasn't passed");
    await expect(subject.issuer.revoke(APP_SID)).rejects.toThrow("checkAccount hasn't passed");
    expect(subject.effects).toEqual([]);
  });

  test("a Restricted key that may read phone numbers proves its secret", async () => {
    const subject = twilio([
      {
        ...APP,
        type: "restricted",
        policy: [
          "/twilio/messaging/messages/create",
          "/twilio/phone-numbers/available-numbers/list",
        ],
      },
    ]);
    await checked(subject);
  });

  test("fits a long key name in Twilio's 64 characters, keeping the run's tag", async () => {
    const subject = twilio();
    await checked(subject);
    const name = "TWILIO_API_SECRET_FOR_THE_BILLING_SERVICE prod 2026-11-18 12:00:00 ab12";
    await subject.issuer.create(name);
    const sent = new URLSearchParams(subject.calls.at(-1)?.body).get("FriendlyName") ?? "";
    expect(sent).toHaveLength(64);
    expect(name.endsWith(sent)).toBe(true);
    expect(subject.issuer.lostCreate(name)).toContain(`"${sent}"`);
  });

  test("works with a Main key or a Restricted key that manages API keys as admin", async () => {
    await checked(twilio([APP, adminKey("main")], KEY_ADMIN));
    const restricted = twilio([APP, adminKey("restricted", MANAGE)], KEY_ADMIN);
    await checked(restricted);
    expect(await restricted.issuer.create("app")).toMatchObject({ id: NEW_SID });
    expect(await restricted.issuer.revoke(APP_SID)).toBe("revoked");
  });

  test("refuses a Standard admin key, which can't manage keys", async () => {
    const check = await refused(twilio([APP, adminKey("standard")], KEY_ADMIN));
    expect(check.facts).toBe(`Twilio answered HTTP 401, code 20003 to the admin key ${ADMIN_SID}`);
    expect(check.reason).toContain("the admin key is a Standard key, which can't manage API keys");
  });

  test("refuses a Restricted admin key without permission to read keys", async () => {
    const check = await refused(
      twilio([APP, adminKey("restricted", ["/twilio/iam/api-keys/create"])], KEY_ADMIN),
    );
    expect(check.reason).toBe(
      "the admin key is a Restricted key without permission to read API keys, or it's from another account",
    );
  });

  test("refuses a Restricted admin key that can read keys but not create or delete them", async () => {
    const subject = twilio([APP, adminKey("restricted", ["/twilio/iam/api-keys/read"])], KEY_ADMIN);
    const check = await refused(subject);
    expect(check.facts).toBe(
      `the admin item holds Restricted key ${ADMIN_SID}, without /twilio/iam/api-keys/create, /twilio/iam/api-keys/delete`,
    );
    expect(subject.effects).toEqual([]);
  });

  test("refuses a wrong auth token", async () => {
    const subject = twilio(
      [APP],
      adminJson({ TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: "wrong" }),
    );
    const check = await refused(subject);
    expect(check.reason).toBe("Twilio doesn't accept the auth token for that Account SID");
  });

  test("refuses a vault secret that isn't its SID's", async () => {
    const check = await refused(twilio(), APP_SID, "wrong");
    expect(check.reason).toBe(
      `the vault's secret isn't the secret of API key ${APP_SID}, or the key can't sign in to account ${ACCOUNT}`,
    );
  });

  test("refuses a Main key in the vault, since the API can't make one", async () => {
    const check = await refused(twilio([{ ...APP, type: "main" }]));
    expect(check.facts).toContain(", a Main key");
    expect(check.reason).toContain("Twilio's API makes only Standard and Restricted keys");
  });

  test("refuses a key of another account, such as a subaccount", async () => {
    const subject = twilio([{ ...APP, account: OTHER_ACCOUNT }]);
    const check = await refused(subject);
    expect(check.facts).toBe(`account ${ACCOUNT} has no API key ${APP_SID}`);
    expect(check.reason).toContain("the admin item needs the subaccount's own SID and credential");
  });

  test("manages a subaccount's keys with the subaccount's own credentials", async () => {
    const sub = { ...APP, account: OTHER_ACCOUNT };
    const subAdmin = { ...adminKey("main"), account: OTHER_ACCOUNT };
    const subject = twilio(
      [sub, subAdmin],
      adminJson({
        TWILIO_ACCOUNT_SID: OTHER_ACCOUNT,
        TWILIO_API_KEY: ADMIN_SID,
        TWILIO_API_SECRET: ADMIN_SECRET,
      }),
    );
    await checked(subject);
    await subject.issuer.create("app");
    expect(subject.world.load().keys.at(-1)?.account).toBe(OTHER_ACCOUNT);
  });

  test.each([
    ["no key SID", null, "keypin doesn't know the vault key's API key SID"],
    ["an Account SID", ACCOUNT, `the key named by key_id holds Account SID ${ACCOUNT}`],
    ["not a key SID", "app-key", "the vault's key ID isn't a Twilio API key SID"],
  ])("refuses %s in the key ID entry without calling Twilio", async (_, id, facts) => {
    const subject = twilio();
    const check = await subject.issuer.checkAccount(id, new Secret(APP_SECRET));
    assert(!check.ok);
    expect(check.facts).toBe(facts);
    expect(subject.calls).toEqual([]);
  });

  test("refuses the rotating key as its own admin", async () => {
    const subject = twilio(
      [APP],
      adminJson({
        TWILIO_ACCOUNT_SID: ACCOUNT,
        TWILIO_API_KEY: APP_SID,
        TWILIO_API_SECRET: APP_SECRET,
      }),
    );
    const check = await refused(subject);
    expect(check.reason).toBe(
      "deleting the old key would leave the admin item with a key that no longer works",
    );
    expect(subject.calls).toEqual([]);
  });

  test.each([
    ["no JSON", TOKEN, "the admin item holds no TWILIO_ACCOUNT_SID"],
    [
      "an Account SID that isn't one",
      adminJson({ TWILIO_ACCOUNT_SID: "acme", TWILIO_AUTH_TOKEN: TOKEN }),
      "the admin item's TWILIO_ACCOUNT_SID isn't an Account SID",
    ],
    [
      "no credential",
      adminJson({ TWILIO_ACCOUNT_SID: ACCOUNT }),
      "the admin item holds no TWILIO_AUTH_TOKEN, and no TWILIO_API_KEY with TWILIO_API_SECRET",
    ],
    [
      "both a token and a key",
      adminJson({
        TWILIO_ACCOUNT_SID: ACCOUNT,
        TWILIO_AUTH_TOKEN: TOKEN,
        TWILIO_API_KEY: ADMIN_SID,
        TWILIO_API_SECRET: ADMIN_SECRET,
      }),
      "the admin item holds both TWILIO_AUTH_TOKEN and an API key",
    ],
    [
      "a key SID that isn't one",
      adminJson({
        TWILIO_ACCOUNT_SID: ACCOUNT,
        TWILIO_API_KEY: "admin",
        TWILIO_API_SECRET: ADMIN_SECRET,
      }),
      "the admin item's TWILIO_API_KEY isn't an API key SID",
    ],
  ])("refuses an admin item with %s", async (_, admin, facts) => {
    const subject = twilio([APP], admin);
    const check = await refused(subject);
    expect(check.facts).toBe(facts);
    expect(subject.calls).toEqual([]);
  });

  test("never retries a create whose reply was lost, and names the key to delete", async () => {
    const subject = twilio(undefined, undefined, { loseCreated: true });
    await checked(subject);
    await expect(subject.issuer.create("app run ab12")).rejects.toThrow("fetch failed");
    expect(subject.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(subject.issuer.lostCreate("app run ab12")).toBe(
      `Twilio may have made the key before the reply was lost. Only this run uses the name "app run ab12": delete the API key with that name in account ${ACCOUNT} at https://console.twilio.com/us1/account/keys-credentials/api-keys before you run this again, or the rerun leaves it live.`,
    );
  });

  test("a create Twilio refuses changes nothing", async () => {
    const denied = twilio(undefined, undefined, { failCreate: 403 });
    await checked(denied);
    await expect(denied.issuer.create("app")).rejects.toBeInstanceOf(NothingChanged);
    const broken = twilio(undefined, undefined, { failCreate: 500 });
    await checked(broken);
    const failed = await broken.issuer.create("app").catch((error: unknown) => error);
    expect(failed).not.toBeInstanceOf(NothingChanged);
  });

  test("revokes by deleting the key, and a missing key is already gone", async () => {
    const subject = twilio();
    await checked(subject);
    expect(await subject.issuer.revoke(APP_SID)).toBe("revoked");
    expect(subject.effects).toEqual([`twilio delete ${APP_SID}`]);
    expect(await subject.issuer.revoke(APP_SID)).toBe("already gone");
    expect(await subject.issuer.revoke("not-a-sid")).toBe("already gone");
  });

  test("on resume, checks the new pair and revokes the old key", async () => {
    const fresh: FakeTwilioKey = {
      sid: NEW_SID,
      secret: "new-secret-1x",
      name: "new",
      type: "standard",
    };
    const subject = twilio([APP, fresh]);
    const check = await checked(subject, NEW_SID, "new-secret-1x");
    expect(check.currentId).toBe(NEW_SID);
    expect(await subject.issuer.revoke(APP_SID)).toBe("revoked");
  });

  test("an admin key that can't delete says to delete the key by hand", async () => {
    const subject = twilio([APP, adminKey("restricted", MANAGE)], KEY_ADMIN);
    await checked(subject);
    const keys = subject.world
      .load()
      .keys.map((k) => (k.sid === ADMIN_SID ? { ...k, policy: MANAGE.slice(0, 2) } : k));
    subject.world.save({ keys, created: 0 });
    await expect(subject.issuer.revoke(APP_SID)).rejects.toThrow(
      `the admin credential can't delete API key ${APP_SID} (HTTP 403, code 70051): delete it at`,
    );
  });

  test("create and revoke refuse until checkAccount passes", async () => {
    const subject = twilio();
    await refused(subject, APP_SID, "wrong");
    await expect(subject.issuer.create("app")).rejects.toThrow("checkAccount");
    await expect(subject.issuer.revoke(APP_SID)).rejects.toThrow("checkAccount");
  });
});

describe("the twilio issuer in secretspec.toml", () => {
  const map = (issuer: string) => `[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
TWILIO_API_SECRET = { description = "TWILIO_API_SECRET", ref = { item = "app twilio secret", field = "credential" } }
TWILIO_API_KEY = { description = "TWILIO_API_KEY", ref = { item = "app twilio key sid", field = "credential" } }

[tool.keypin.prod.TWILIO_API_SECRET]
${issuer}
`;

  test("names the key that holds the API key SID", () => {
    const parsed = readSecretspec(
      map(`[tool.keypin.prod.TWILIO_API_SECRET.issuer]
kind = "twilio"
admin = "op://Private/twilio admin/credential"
key_id = "TWILIO_API_KEY"`),
      "secretspec.toml",
      [],
      [twilioIssuer],
      [onePasswordVault],
    );
    assert(parsed.ok, JSON.stringify(parsed));
    const entry = parsed.map.keys[0]?.environments.prod;
    expect(entry?.idKey).toBe("TWILIO_API_KEY");
    expect(entry?.issuer?.kind).toBe("twilio");
  });

  test("requires key_id", () => {
    const parsed = readSecretspec(
      map(`[tool.keypin.prod.TWILIO_API_SECRET.issuer]
kind = "twilio"
admin = "op://Private/twilio admin/credential"`),
      "secretspec.toml",
      [],
      [twilioIssuer],
      [onePasswordVault],
    );
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain('"key_id"');
  });
});
