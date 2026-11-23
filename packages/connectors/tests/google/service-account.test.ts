import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, readSecretspec, parseObject, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { googleServiceAccountIssuer, ServiceAccountKeyIssuer } from "../../src/google/index";
import {
  type FakeIam,
  type FakeIamKey,
  fakePrivateKey,
  iamFetch,
  iamKeyFile,
  memoryIamWorld,
  serviceAccountJson,
  serviceAccountKeyId,
} from "../../src/google/testing";

const ADMIN_EMAIL = "keypin@acme-admin.iam.gserviceaccount.com";
const PRIVATE_KEY = fakePrivateKey();
const ADMIN = serviceAccountJson(ADMIN_EMAIL, PRIVATE_KEY, serviceAccountKeyId(0xadd));
const APP = "app@acme-prod.iam.gserviceaccount.com";
const OLD_ID = serviceAccountKeyId(0xf00);
const OLD_NAME = `projects/acme-prod/serviceAccounts/${APP}/keys/${OLD_ID}`;
const VAULT = iamKeyFile(APP, "acme-prod", OLD_ID, "vault-pem");
const FIRST = serviceAccountKeyId(1);
const FIRST_NAME = `projects/acme-prod/serviceAccounts/${APP}/keys/${FIRST}`;

function iam(keys: FakeIamKey[] = [{ id: OLD_ID }], options: Partial<FakeIam> = {}, admin = ADMIN) {
  const effects: string[] = [];
  const requests: { method: string; path: string; body: string }[] = [];
  const world = memoryIamWorld([{ email: APP, project: "acme-prod", keys }]);
  const fake: FakeIam = {
    serviceAccount: ADMIN_EMAIL,
    privateKey: PRIVATE_KEY,
    manages: [APP],
    keyPrefix: "new-pem-",
    world,
    effect: (line) => void effects.push(line),
    ...options,
  };
  const inner = iamFetch(fake);
  const fetch: Fetch = (url, init) => {
    const { pathname, search } = new URL(url);
    requests.push({ method: init.method, path: pathname + search, body: init.body ?? "" });
    return inner(url, init);
  };
  const sleeps: number[] = [];
  const issuer = new ServiceAccountKeyIssuer({
    admin: async () => new Secret(admin),
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  const writes = () => requests.filter((r) => r.method !== "GET" && !r.path.endsWith("/token"));
  return { issuer, fake, world, effects, requests, writes, sleeps };
}

async function checked(subject: ReturnType<typeof iam>, current = VAULT) {
  const check = await subject.issuer.checkAccount(null, new Secret(current));
  assert(check.ok, JSON.stringify(check));
  return check;
}

async function refused(subject: ReturnType<typeof iam>, current = VAULT, id: string | null = null) {
  const check = await subject.issuer.checkAccount(id, new Secret(current));
  assert(!check.ok, JSON.stringify(check));
  expect(subject.writes()).toEqual([]);
  return check;
}

describe("Google Cloud service account key issuer", () => {
  test("finds the vault's key by its key ID and service account, and makes a key file for it", async () => {
    const subject = iam();
    const check = await checked(subject);
    expect(check.facts).toBe(`the vault holds key ${OLD_ID} of service account ${APP}`);
    expect(check.currentId).toBe(OLD_NAME);
    expect(check.notes).toEqual({
      create: `for ${APP}, which has 1 of 10 keys`,
      revoke: "keypin disables it, then deletes it; a deleted key can't come back",
    });
    expect(subject.requests.find((r) => r.method === "GET")?.path).toBe(
      `/v1/projects/acme-prod/serviceAccounts/${APP}/keys?keyTypes=USER_MANAGED`,
    );
    const created = await subject.issuer.create();
    expect(created.id).toBe(FIRST_NAME);
    const file = parseObject(created.secret.reveal());
    expect(file).toMatchObject({
      type: "service_account",
      client_email: APP,
      private_key_id: FIRST,
    });
    expect(file.private_key).toMatch(/^new-pem-1\n-----BEGIN PRIVATE KEY-----\n/);
    expect(subject.sleeps).toEqual([]);
    expect(JSON.parse(subject.writes()[0]?.body ?? "")).toEqual({
      privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
    });
    expect(subject.issuer.label(created.id)).toBe(FIRST);
    expect(subject.issuer.dashboard()).toBe(
      "https://console.cloud.google.com/iam-admin/serviceaccounts?project=acme-prod",
    );
  });

  test("lists the service account's other keys in the plan", async () => {
    const subject = iam([
      { id: serviceAccountKeyId(0xbee), created: "2026-01-02T00:00:00Z", disabled: true },
      { id: OLD_ID },
      { id: serviceAccountKeyId(0x5e5), type: "SYSTEM_MANAGED" },
    ]);
    const check = await checked(subject);
    expect(check.notes?.create).toBe(
      `for ${APP}, which has 2 of 10 keys: ${serviceAccountKeyId(0xbee)} (disabled), created 2026-01-02 and this one`,
    );
  });

  test("a key file without project_id is found through any project", async () => {
    const { project_id: _, ...file } = parseObject(VAULT);
    const subject = iam();
    const check = await checked(subject, JSON.stringify(file));
    expect(check.currentId).toBe(`projects/-/serviceAccounts/${APP}/keys/${OLD_ID}`);
    const created = await subject.issuer.create();
    expect(created.id).toBe(`projects/-/serviceAccounts/${APP}/keys/${FIRST}`);
    expect(subject.issuer.dashboard()).toBe(
      "https://console.cloud.google.com/iam-admin/serviceaccounts",
    );
  });

  test("checks the issued key by its name, and refuses one the vault's file doesn't match", async () => {
    const subject = iam([{ id: OLD_ID }, { id: FIRST }]);
    const issued = iamKeyFile(APP, "acme-prod", FIRST, "pem");
    const ok = await subject.issuer.checkAccount(FIRST_NAME, new Secret(issued));
    assert(ok.ok);
    expect(ok.facts).toBe(`keypin issued key ${FIRST} of service account ${APP}`);
    expect(ok.currentId).toBeUndefined();
    const other = iamKeyFile("other@acme-prod.iam.gserviceaccount.com", "acme-prod", FIRST, "pem");
    const check = await refused(subject, other, FIRST_NAME);
    expect(check.reason).toBe(
      "the vault's key belongs to another service account than the key keypin issued",
    );
  });

  test.each([
    [
      "an API key",
      "AIzaSyVaultVaultVaultVaultVaultVault0001",
      "the vault holds no service account key",
    ],
    [
      "a gcloud user login",
      JSON.stringify({ type: "authorized_user", client_id: "x" }),
      "the vault holds a gcloud user login (authorized_user)",
    ],
    [
      "a key file without its key ID",
      JSON.stringify({ type: "service_account", client_email: APP, private_key: "pem" }),
      "the vault holds no service account key",
    ],
    [
      "a key ID that isn't hexadecimal",
      iamKeyFile(APP, "acme-prod", "not-a-key-id", "pem"),
      `the vault holds a key of ${APP} with an ID keypin can't read`,
    ],
  ])("refuses %s in the vault before calling Google", async (_, value, facts) => {
    const subject = iam();
    const check = await refused(subject, value);
    expect(check.facts).toBe(facts);
    expect(subject.requests).toEqual([]);
  });

  test("refuses the rotated key acting as its own admin", async () => {
    const admin = serviceAccountJson(APP, PRIVATE_KEY, OLD_ID);
    const subject = iam([{ id: OLD_ID }], { serviceAccount: APP }, admin);
    const check = await refused(subject);
    expect(check.facts).toBe(
      `the admin item holds key ${OLD_ID} of ${APP}, the key keypin would rotate`,
    );
    expect(check.fix).toContain("give keypin a key of another service account");
    expect(subject.requests).toEqual([]);
  });

  test("refuses an admin item that holds a gcloud login", async () => {
    const subject = iam([{ id: OLD_ID }], {}, JSON.stringify({ type: "authorized_user" }));
    const check = await refused(subject);
    expect(check.facts).toBe("the admin item holds a gcloud user login (authorized_user)");
    expect(check.fix).toContain("Service Account Key Admin");
  });

  test("an admin without Service Account Key Admin on the account is refused", async () => {
    const subject = iam([{ id: OLD_ID }], { manages: [] });
    const check = await refused(subject);
    expect(check.reason).toBe(
      `the admin service account can't list the keys of ${APP}: it has no Service Account Key Admin role on it, or the service account was deleted`,
    );
  });

  test("a service account Google doesn't have is refused", async () => {
    const subject = iam();
    const file = iamKeyFile(APP, "acme-old", OLD_ID, "pem");
    const check = await refused(subject, file);
    expect(check.reason).toBe(
      `Google has no service account ${APP} in project acme-old: it was deleted, or the vault holds an old key file`,
    );
  });

  test("says which project must turn on the IAM API", async () => {
    const subject = iam([{ id: OLD_ID }], { apiDisabledIn: "acme-admin" });
    const check = await refused(subject);
    expect(check).toMatchObject({
      reason:
        "the IAM API is turned off in project acme-admin, the admin service account's project",
      fix: "turn on iam.googleapis.com at https://console.cloud.google.com/apis/library/iam.googleapis.com?project=acme-admin",
    });
  });

  test("a deleted key, or one Google manages, is refused", async () => {
    const deleted = await refused(iam([]));
    expect(deleted.reason).toBe(
      `Google doesn't list key ${OLD_ID} among the user-managed keys of ${APP}: it was deleted`,
    );
    const managed = await refused(iam([{ id: OLD_ID, type: "SYSTEM_MANAGED" }]));
    expect(managed.reason).toBe(deleted.reason);
  });

  test("an uploaded key is refused", async () => {
    const check = await refused(iam([{ id: OLD_ID, origin: "USER_PROVIDED" }]));
    expect(check.facts).toBe(`the vault holds key ${OLD_ID} of service account ${APP}, uploaded`);
    expect(check.reason).toContain("keypin can only ask Google to make the new key");
  });

  test("a disabled vault key still rotates, and says so", async () => {
    const check = await checked(iam([{ id: OLD_ID, disabled: true }]));
    expect(check.facts).toBe(`the vault holds key ${OLD_ID} of service account ${APP}, disabled`);
  });

  test("a full service account stops before creating", async () => {
    const keys = Array.from({ length: 10 }, (_, n) => ({
      id: n ? serviceAccountKeyId(0xa00 + n) : OLD_ID,
    }));
    const subject = iam(keys);
    await checked(subject);
    const failed = await subject.issuer.create().catch((error: unknown) => error);
    assert(failed instanceof NothingChanged);
    expect(failed.message).toBe(
      `${APP} already has 10 keys, the most Google allows. Delete one nothing uses at https://console.cloud.google.com/iam-admin/serviceaccounts?project=acme-prod, then run this again`,
    );
    expect(subject.writes()).toEqual([]);
  });

  test.each([
    "iam.disableServiceAccountKeyCreation",
    "iam.managed.disableServiceAccountKeyCreation",
  ])("says plainly when the organization policy %s blocks new keys", async (policy) => {
    const subject = iam([{ id: OLD_ID }], { policy });
    await checked(subject);
    const failed = await subject.issuer.create().catch((error: unknown) => error);
    assert(failed instanceof NothingChanged);
    expect(failed.message).toBe(
      `the organization policy ${policy} stops new service account keys in project acme-prod; organizations created since May 2024 have it on by default. An organization policy admin can turn it off for this project at https://console.cloud.google.com/iam-admin/orgpolicies?project=acme-prod, or move the app to workload identity federation, which needs no key`,
    );
    expect(subject.effects).toEqual([]);
  });

  test("waits with backoff until Google accepts the new key, since new keys take a while to work", async () => {
    const subject = iam([{ id: OLD_ID }], { unready: 3 });
    await checked(subject);
    const created = await subject.issuer.create();
    expect(created.id).toBe(FIRST_NAME);
    expect(subject.sleeps).toEqual([1000, 2000, 4000]);
    expect(subject.requests.filter((r) => r.path === "/token")).toHaveLength(5);
    expect(subject.effects).toEqual([`google-iam create ${APP}/${FIRST}`]);
  });

  test("deletes a new key Google never accepts, and says nothing changed", async () => {
    const subject = iam([{ id: OLD_ID }], { unready: 100 });
    await checked(subject);
    const failed = await subject.issuer.create().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NothingChanged);
    expect(String(failed)).toContain(
      `Google didn't accept the new key ${FIRST} of ${APP} within 120 seconds, so keypin deleted it. Run this again`,
    );
    expect(subject.sleeps).toEqual([1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000]);
    expect(subject.effects).toEqual([
      `google-iam create ${APP}/${FIRST}`,
      `google-iam delete ${APP}/${FIRST}`,
    ]);
    expect(subject.world.load().accounts[0]?.keys.map((k) => k.id)).toEqual([OLD_ID]);
  });

  test("a new key Google never accepts and keypin can't delete is named, with the gcloud command", async () => {
    const subject = iam([{ id: OLD_ID }], { unready: 100, failDelete: true });
    await checked(subject);
    const failed = await subject.issuer.create().catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed).not.toBeInstanceOf(NothingChanged);
    expect(failed.message).toBe(
      `Google didn't accept the new key ${FIRST} of ${APP} within 120 seconds, and keypin couldn't delete it: run gcloud iam service-accounts keys delete ${FIRST} --iam-account=${APP}, then run this again`,
    );
  });

  test("a create Google refuses changes nothing", async () => {
    const subject = iam([{ id: OLD_ID }], { failCreate: 403 });
    await checked(subject);
    const failed = await subject.issuer.create().catch((error: unknown) => error);
    assert(failed instanceof NothingChanged);
    expect(failed.message).toContain(`the admin service account can't create keys for ${APP}`);
  });

  test("a lost create says which keys to keep", async () => {
    const subject = iam([{ id: OLD_ID }], { loseCreated: true });
    await checked(subject);
    await expect(subject.issuer.create()).rejects.toThrow("fetch failed");
    expect(subject.effects).toEqual([`google-iam create ${APP}/${FIRST}`]);
    expect(subject.issuer.lostCreate()).toBe(
      `Google may have made a key for ${APP} before the reply was lost, and keys have no name to find it by. Run gcloud iam service-accounts keys list --iam-account=${APP} --managed-by=user: keep ${OLD_ID}, and delete any other key with gcloud iam service-accounts keys delete <ID> --iam-account=${APP} before you run this again.`,
    );
  });

  test("revoking disables the key, then deletes it, and a repeat is already gone", async () => {
    const subject = iam();
    await checked(subject);
    expect(await subject.issuer.revoke(OLD_NAME)).toBe("revoked");
    const path = `/v1/projects/acme-prod/serviceAccounts/${APP}/keys/${OLD_ID}`;
    expect(subject.writes().map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${path}:disable`,
      `DELETE ${path}`,
    ]);
    expect(await subject.issuer.revoke(OLD_NAME)).toBe("already gone");
    expect(subject.writes()).toHaveLength(2);
  });

  test("a key a failed run already disabled is only deleted", async () => {
    const subject = iam([{ id: OLD_ID }, { id: FIRST, disabled: true }]);
    await checked(subject);
    expect(await subject.issuer.revoke(FIRST_NAME)).toBe("revoked");
    expect(subject.writes().map((r) => r.method)).toEqual(["DELETE"]);
  });

  test("a delete that fails after the disable says the key no longer works", async () => {
    const subject = iam();
    await checked(subject);
    const inner = iamFetch(subject.fake);
    const failing = new ServiceAccountKeyIssuer({
      admin: async () => new Secret(ADMIN),
      fetch: (url, init) =>
        init.method === "DELETE"
          ? Promise.resolve(
              new Response(JSON.stringify({ error: { status: "INTERNAL" } }), { status: 500 }),
            )
          : inner(url, init),
    });
    await failing.checkAccount(null, new Secret(VAULT));
    await expect(failing.revoke(OLD_NAME)).rejects.toThrow(
      `keypin disabled key ${OLD_ID} of ${APP}, so it no longer works, but couldn't delete it (Google DELETE <account>/keys/<id> returned HTTP 500 INTERNAL): delete it at https://console.cloud.google.com/iam-admin/serviceaccounts?project=acme-prod`,
    );
  });

  test("refuses an issued ID that isn't a key name", async () => {
    const check = await refused(iam(), VAULT, "key_123");
    expect(check.reason).toBe("key_123 isn't a Google Cloud service account key name");
  });
});

describe("the google-service-account issuer kind", () => {
  const map = (extra: string) => `[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
GOOGLE_APPLICATION_CREDENTIALS = { description = "GOOGLE_APPLICATION_CREDENTIALS", ref = { item = "app service account", field = "credential" } }

[tool.keypin.prod.GOOGLE_APPLICATION_CREDENTIALS]
issuer = { kind = "google-service-account", admin = "op://Private/google key admin/credential", ${extra} }
`;
  const parse = (extra: string) =>
    readSecretspec(
      map(extra),
      "secretspec.toml",
      [],
      [googleServiceAccountIssuer],
      [onePasswordVault],
    );

  test("takes only the admin item", () => {
    const parsed = parse("");
    assert(parsed.ok, JSON.stringify(parsed));
    expect(parsed.map.keys[0]?.environments.prod?.issuer).toMatchObject({
      kind: "google-service-account",
    });
  });

  test("refuses other fields", () => {
    const parsed = parse(`project_number = "481537286014"\n`);
    expect(parsed.ok).toBe(false);
  });
});
