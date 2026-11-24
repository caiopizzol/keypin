import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, readSecretspec, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { GoogleIssuer, googleIssuer } from "../../src/google/index";
import { keyIdOf } from "../../src/google/google";
import {
  type FakeGoogle,
  type FakeGoogleKey,
  fakePrivateKey,
  googleFetch,
  memoryWorld,
  serviceAccountJson,
} from "../../src/google/testing";

const EMAIL = "keypin@acme-admin.iam.gserviceaccount.com";
const PRIVATE_KEY = fakePrivateKey();
const ADMIN = serviceAccountJson(EMAIL, PRIVATE_KEY);
const VAULT = "AIzaSyVaultVaultVaultVaultVaultVault0001";
const PREFIX = "AIzaSyIssuedIssuedIssued";
const OLD_NAME = "projects/481537286014/locations/global/keys/maps-web";
const RESTRICTIONS = {
  apiTargets: [{ service: "maps-backend.googleapis.com" }, { service: "places.googleapis.com" }],
  browserKeyRestrictions: { allowedReferrers: ["https://acme.example/*", "*.acme.example/*"] },
};
const OLD: FakeGoogleKey = {
  name: OLD_NAME,
  value: VAULT,
  displayName: "Maps web",
  restrictions: RESTRICTIONS,
};
const NAME = "web GOOGLE_MAPS_API_KEY prod 2026-11-17T12:00Z a1b2c3";

function google(
  keys: FakeGoogleKey[] = [OLD],
  options: Partial<FakeGoogle> = {},
  admin = ADMIN,
  projectNumber = "481537286014",
) {
  const effects: string[] = [];
  const requests: { method: string; path: string; body: string }[] = [];
  const sleeps: number[] = [];
  const world = memoryWorld(keys);
  const fake: FakeGoogle = {
    serviceAccount: EMAIL,
    privateKey: PRIVATE_KEY,
    projects: ["481537286014"],
    valuePrefix: PREFIX,
    world,
    effect: (line) => void effects.push(line),
    ...options,
  };
  const inner = googleFetch(fake);
  const fetch: Fetch = (url, init) => {
    const { pathname } = new URL(url);
    requests.push({ method: init.method, path: pathname, body: init.body ?? "" });
    return inner(url, init);
  };
  let now = new Date("2026-11-17T12:00:00Z");
  const issuer = new GoogleIssuer({
    admin: async () => new Secret(admin),
    projectNumber,
    fetch,
    now: () => now,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return {
    issuer,
    fake,
    world,
    effects,
    requests,
    sleeps,
    later: (ms: number) => void (now = new Date(now.getTime() + ms)),
  };
}

async function checked(subject: ReturnType<typeof google>, current = VAULT) {
  const check = await subject.issuer.checkAccount(null, new Secret(current));
  assert(check.ok, JSON.stringify(check));
  return check;
}

describe("Google Cloud issuer", () => {
  test("finds the vault's key by its value and copies its API targets, websites and name", async () => {
    const subject = google();
    const check = await checked(subject);
    expect(check.currentId).toBe(OLD_NAME);
    expect(check.facts).toBe('the vault holds key "Maps web" (maps-web) in project 481537286014');
    expect(check.notes?.create).toBe(
      "with the old key's API targets maps-backend.googleapis.com, places.googleapis.com and 2 websites",
    );
    const created = await subject.issuer.create(NAME);
    expect(created.id).toBe(
      "projects/481537286014/locations/global/keys/web-google-maps-api-key-prod-2026-11-17t12-00z-a1b2c3",
    );
    expect(created.secret.equals(new Secret(`${PREFIX}1x`))).toBe(true);
    const post = subject.requests.find((r) => r.method === "POST" && r.path.endsWith("/keys"));
    expect(JSON.parse(post?.body ?? "")).toEqual({
      displayName: NAME,
      restrictions: RESTRICTIONS,
    });
    expect(subject.issuer.label(created.id)).toBe(
      "web-google-maps-api-key-prod-2026-11-17t12-00z-a1b2c3",
    );
  });

  test("copies IP, Android and iOS restrictions as they are", async () => {
    const restrictions = {
      apiTargets: [{ service: "youtube.googleapis.com", methods: ["Get*"] }],
      serverKeyRestrictions: { allowedIps: ["192.0.2.10", "2001:db8::/32"] },
      androidKeyRestrictions: {
        allowedApplications: [
          {
            packageName: "com.acme.app",
            sha1Fingerprint: "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709",
          },
        ],
      },
      iosKeyRestrictions: { allowedBundleIds: ["com.acme.app"] },
    };
    const subject = google([{ ...OLD, restrictions }]);
    const check = await checked(subject);
    expect(check.notes?.create).toBe(
      "with the old key's API target youtube.googleapis.com, 2 IP addresses, 1 Android app and 1 iOS app",
    );
    await subject.issuer.create(NAME);
    const post = subject.requests.find((r) => r.method === "POST" && r.path.endsWith("/keys"));
    expect(JSON.parse(post?.body ?? "")).toMatchObject({ restrictions });
  });

  test("a key in another project than project_number is refused before anything is created", async () => {
    const subject = google([OLD], {}, ADMIN, "729401556318");
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "secretspec.toml names project_number 729401556318, and the key is in project 481537286014",
    );
    expect(subject.requests.some((r) => r.method !== "GET" && !r.path.endsWith("/token"))).toBe(
      false,
    );
  });

  test("a key with no restrictions gets a new key with none", async () => {
    const subject = google([{ name: OLD_NAME, value: VAULT, displayName: "API key 1" }]);
    const check = await checked(subject);
    expect(check.notes?.create).toBe("with no restrictions, like the old key");
    await subject.issuer.create(NAME);
    const post = subject.requests.find((r) => r.method === "POST" && r.path.endsWith("/keys"));
    expect(JSON.parse(post?.body ?? "")).toEqual({ displayName: NAME });
  });

  test("a key without a display name still rotates, and the new key gets keypin's name", async () => {
    const subject = google([{ name: OLD_NAME, value: VAULT }]);
    const check = await checked(subject);
    expect(check.notes?.create).toBe("with no restrictions, like the old key");
    await subject.issuer.create(NAME);
    const post = subject.requests.find((r) => r.method === "POST" && r.path.endsWith("/keys"));
    expect(JSON.parse(post?.body ?? "")).toEqual({ displayName: NAME });
  });

  test("waits for the create operation to finish", async () => {
    const subject = google([OLD], { pendingPolls: 3 });
    await checked(subject);
    const created = await subject.issuer.create(NAME);
    expect(created.secret.equals(new Secret(`${PREFIX}1x`))).toBe(true);
    expect(subject.sleeps).toEqual([2000, 2000, 2000, 2000]);
  });

  test("a create operation that doesn't finish in a minute may have made the key", async () => {
    const subject = google([OLD], { pendingPolls: 1000 });
    await checked(subject);
    const failed = await subject.issuer.create(NAME).catch((error: unknown) => error);
    assert(failed instanceof Error);
    expect(failed).not.toBeInstanceOf(NothingChanged);
    expect(failed.message).toBe("Google Cloud hasn't finished creating the key after 60 seconds");
    expect(subject.issuer.lostCreate(NAME)).toBe(
      'Google Cloud may have made the key, or may still be making it. Only this run uses key ID web-google-maps-api-key-prod-2026-11-17t12-00z-a1b2c3 and the name "web GOOGLE_MAPS_API_KEY prod 2026-11-17T12:00Z a1b2c3": delete that key at https://console.cloud.google.com/apis/credentials?project=481537286014 before you run this again, or the rerun leaves it live.',
    );
  });

  test("a create operation that ends in an error changed nothing", async () => {
    const subject = google([OLD], { failOperation: true });
    await checked(subject);
    await expect(subject.issuer.create(NAME)).rejects.toThrow(
      new NothingChanged("Google Cloud didn't create the key: the operation ended with code 9"),
    );
  });

  test("reads the key string when the operation doesn't return it", async () => {
    const subject = google([OLD], { noKeyString: true });
    await checked(subject);
    const created = await subject.issuer.create(NAME);
    expect(created.secret.equals(new Secret(`${PREFIX}1x`))).toBe(true);
    expect(subject.requests.at(-1)?.path).toMatch(/\/keyString$/);
  });

  test("a create Google refuses for permissions changed nothing", async () => {
    const subject = google([OLD], { failCreate: 403 });
    await checked(subject);
    const failed = await subject.issuer.create(NAME).catch((error: unknown) => error);
    assert(failed instanceof NothingChanged);
    expect(failed.message).toContain("can't create keys in project 481537286014");
    expect(failed.message).not.toContain("ya29");
  });

  test("deletes the old key, then calls it already gone", async () => {
    const subject = google();
    const check = await checked(subject);
    expect(check.notes?.revoke).toBe("Google Cloud can restore it for 30 days");
    expect(await subject.issuer.revoke(OLD_NAME)).toBe("revoked");
    expect(await subject.issuer.revoke(OLD_NAME)).toBe("already gone");
    expect(subject.effects).toEqual([`google delete ${OLD_NAME}`]);
  });

  test("checks the key keypin issued last time by its name", async () => {
    const issued = "projects/481537286014/locations/global/keys/google-maps-api-key-prod-x";
    const subject = google([{ ...OLD, name: issued, displayName: "Maps web" }]);
    const check = await subject.issuer.checkAccount(issued, new Secret("anything"));
    expect(check).toMatchObject({
      ok: true,
      facts: 'keypin issued key "Maps web" (google-maps-api-key-prod-x) in project 481537286014',
    });
    expect(subject.requests.some((r) => r.path.endsWith(":lookupKey"))).toBe(false);
  });

  test("gets a new access token once the old one is about to expire", async () => {
    const subject = google();
    await checked(subject);
    subject.later(3_600_000);
    await subject.issuer.revoke(OLD_NAME);
    expect(subject.requests.filter((r) => r.path === "/token")).toHaveLength(2);
  });
});

describe("Google Cloud issuer refusals", () => {
  test.each([
    ["authorized_user", "a gcloud user login (authorized_user)"],
    ["external_account", "a workload identity federation config (external_account)"],
    ["impersonated_service_account", "an impersonation config (impersonated_service_account)"],
  ])("refuses %s in the admin item", async (type, held) => {
    const subject = google([OLD], {}, JSON.stringify({ type, client_id: "x" }));
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    expect(check).toEqual({
      ok: false,
      facts: `the admin item holds ${held}`,
      reason:
        "keypin signs in to Google only with a service account key, so it runs without gcloud",
      fix: "put a JSON key of a service account with the API Keys Admin role in the admin item; create one at https://console.cloud.google.com/iam-admin/serviceaccounts",
    });
    expect(subject.requests).toEqual([]);
  });

  test("refuses an admin item that isn't a service account key", async () => {
    const subject = google([OLD], {}, "AIzaSyNotAServiceAccountKeyAtAll000000");
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.facts).toBe("the admin item holds no service account key");
    expect(subject.requests).toEqual([]);
  });

  test("refuses a service account key whose private key can't be read", async () => {
    const admin = serviceAccountJson(
      EMAIL,
      "-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----\n",
    );
    const subject = google([OLD], {}, admin);
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe("its private_key isn't a private key keypin can read");
  });

  test("refuses a service account key Google doesn't accept", async () => {
    const subject = google([OLD], {}, serviceAccountJson(EMAIL, fakePrivateKey()));
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    expect(check).toMatchObject({
      ok: false,
      facts: "Google answered HTTP 400 invalid_grant",
      reason: `Google doesn't accept the key of service account ${EMAIL}: the key or the service account was deleted or disabled, or this computer's clock is off`,
    });
  });

  test("refuses a vault value that isn't a Google API key, without sending it", async () => {
    const subject = google();
    const check = await subject.issuer.checkAccount(null, new Secret("sk-not-a-google-key-000000"));
    assert(!check.ok);
    expect(check.facts).toBe("the vault holds a value that doesn't start with AIza");
    expect(subject.requests.map((r) => r.path)).toEqual(["/token"]);
  });

  test("refuses a key Google doesn't know", async () => {
    const subject = google();
    const check = await subject.issuer.checkAccount(
      null,
      new Secret("AIzaSyUnknownUnknownUnknownUnknown0000"),
    );
    assert(!check.ok);
    expect(check.reason).toBe(
      "Google Cloud doesn't know the vault's key: it was deleted, or the item holds another value",
    );
  });

  test("refuses a key the admin can't look up", async () => {
    const subject = google([OLD], { projects: ["729401556318"] });
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      "the admin service account can't look up the vault's key: it has no API Keys Admin role on the key's project",
    );
  });

  test("refuses a key deleted more than 30 days ago", async () => {
    const subject = google([{ ...OLD, purged: true }]);
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    expect(check).toMatchObject({
      ok: false,
      facts: "Google knows the vault's key in projects/481537286014, but no longer lists it",
    });
  });

  test("refuses a deleted key", async () => {
    const subject = google([{ ...OLD, deleteTime: "2026-11-10T00:00:00Z" }]);
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe(
      `key "Maps web" (maps-web) is deleted at Google Cloud, and keypin won't make a live copy of it`,
    );
  });

  test("refuses a key bound to a service account", async () => {
    const subject = google([
      { ...OLD, serviceAccountEmail: "app@acme-prod.iam.gserviceaccount.com" },
    ]);
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe("keypin doesn't copy a key bound to a service account yet");
  });

  test("says which project must turn on the API Keys API", async () => {
    const subject = google([OLD], { apiDisabledIn: "acme-admin" });
    const check = await subject.issuer.checkAccount(null, new Secret(VAULT));
    expect(check).toMatchObject({
      ok: false,
      reason:
        "the API Keys API is turned off in project acme-admin, the admin service account's project",
      fix: "turn on apikeys.googleapis.com at https://console.cloud.google.com/apis/library/apikeys.googleapis.com?project=acme-admin",
    });
  });

  test("refuses an issued ID that isn't a key name", async () => {
    const subject = google();
    const check = await subject.issuer.checkAccount("key_123", new Secret(VAULT));
    assert(!check.ok);
    expect(check.reason).toBe("key_123 isn't a Google Cloud API key name");
  });

  test("refuses when the issued key is gone", async () => {
    const subject = google();
    const check = await subject.issuer.checkAccount(
      "projects/481537286014/locations/global/keys/gone",
      new Secret(VAULT),
    );
    assert(!check.ok);
    expect(check.reason).toContain("the one keypin issued last time");
  });

  test("a delete Google refuses says where to delete the key", async () => {
    const subject = google();
    await checked(subject);
    subject.fake.projects = ["729401556318"];
    await expect(subject.issuer.revoke(OLD_NAME)).rejects.toThrow(
      `the admin service account can't delete key "Maps web" (maps-web): put a JSON key of a service account with the API Keys Admin role in the admin item; create one at https://console.cloud.google.com/iam-admin/serviceaccounts, or delete it at https://console.cloud.google.com/apis/credentials?project=481537286014`,
    );
    expect(subject.effects).toEqual([]);
  });
});

describe("key IDs", () => {
  test("keypin's name becomes a valid key ID", () => {
    expect(keyIdOf(NAME)).toBe("web-google-maps-api-key-prod-2026-11-17t12-00z-a1b2c3");
  });

  test("a long name keeps its start and the run's tag", () => {
    expect(keyIdOf(`web ${"VERY_LONG_".repeat(8)}KEY prod 2026-11-17T12:00Z a1b2c3`)).toBe(
      "web-very-long-very-long-very-long-very-long-very-long-v-a1b2c3",
    );
    expect(keyIdOf(`9web ${"VERY_LONG_".repeat(8)} prod 2026-11-17T12:00Z a1b2c3`)).toBe(
      "k-9web-very-long-very-long-very-long-very-long-very-lon-a1b2c3",
    );
  });

  test("a name that starts with a digit gets a letter first", () => {
    expect(keyIdOf("1PASSWORD_KEY dev")).toBe("k-1password-key-dev");
  });
});

describe("the google issuer kind", () => {
  const map = (issuer: string) => `[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
GEMINI_API_KEY = { description = "GEMINI_API_KEY", ref = { item = "gemini key", field = "credential" } }

[tool.keypin.prod.GEMINI_API_KEY.issuer]
kind = "google"
admin = "op://Private/google key maker/credential"
${issuer}`;

  test("takes the admin item and the project ID", () => {
    const parsed = readSecretspec(
      map(`project_number = "481537286014"\n`),
      "secretspec.toml",
      [],
      [googleIssuer],
      [onePasswordVault],
    );
    assert(parsed.ok, JSON.stringify(parsed));
    expect(parsed.map.keys[0]?.environments.prod?.issuer).toMatchObject({
      kind: "google",
      projectNumber: "481537286014",
    });
  });

  test("refuses a project ID where the project number belongs", () => {
    const parsed = readSecretspec(
      map(`project_number = "acme-prod"\n`),
      "secretspec.toml",
      [],
      [googleIssuer],
      [onePasswordVault],
    );
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain(
      'field "project_number" must be the project\'s number, digits only, not its ID',
    );
  });

  test("needs project_number", () => {
    const parsed = readSecretspec(
      map(""),
      "secretspec.toml",
      [],
      [googleIssuer],
      [onePasswordVault],
    );
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain(`missing field "project_number"`);
  });

  test("rejects other fields", () => {
    const parsed = readSecretspec(
      map(`project_number = "481537286014"\nlocation = "global"\n`),
      "secretspec.toml",
      [],
      [googleIssuer],
      [onePasswordVault],
    );
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain(`unknown field "location" for google`);
  });
});
