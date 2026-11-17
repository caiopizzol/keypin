import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, NothingChanged, parseMap, Secret } from "@keypin/core";
import { onePasswordVault } from "@keypin/connectors/onepassword";
import { AwsIssuer, awsIssuer } from "../../src/aws/index";
import {
  accessKeyJson,
  awsFetch,
  type FakeAws,
  type FakeAwsKey,
  memoryWorld,
} from "../../src/aws/testing";

const ADMIN_ID = "AKIAADMINADMINADMIN1";
const ADMIN_SECRET = "admin/secret/value/0001";
const ADMIN = accessKeyJson(ADMIN_ID, ADMIN_SECRET);
const APP_ID = "AKIAAPPAPPAPPAPP0001";
const APP_SECRET = "app/secret/value/0001";
const ADMIN_KEY: FakeAwsKey = { id: ADMIN_ID, secret: ADMIN_SECRET, user: "keypin-admin" };
const APP_KEY: FakeAwsKey = { id: APP_ID, secret: APP_SECRET, user: "app" };
const NEW_ID = "AKIANEW0000000000001";

function aws(
  keys: FakeAwsKey[] = [ADMIN_KEY, APP_KEY],
  options: Partial<FakeAws> = {},
  admin = ADMIN,
) {
  const effects: string[] = [];
  const actions: { action: string; params: Record<string, string>; signer: string }[] = [];
  const sleeps: number[] = [];
  const world = memoryWorld(keys);
  const fake: FakeAws = {
    account: "123456789012",
    idPrefix: "AKIANEW",
    valuePrefix: "new/secret/",
    world,
    effect: (line) => void effects.push(line),
    ...options,
  };
  const inner = awsFetch(fake);
  const fetch: Fetch = (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(init.body ?? ""));
    const { Action: action = "", Version: _version, ...rest } = params;
    const signer = /Credential=([A-Z0-9]+)\//.exec(init.headers.Authorization ?? "")?.[1] ?? "";
    actions.push({ action, params: rest, signer });
    return inner(url, init);
  };
  const issuer = new AwsIssuer({
    admin: async () => new Secret(admin),
    fetch,
    now: () => new Date("2026-11-17T12:00:00Z"),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { issuer, fake, world, effects, actions, sleeps };
}

async function checked(subject: ReturnType<typeof aws>, id = APP_ID, secret = APP_SECRET) {
  const check = await subject.issuer.checkAccount(id, new Secret(secret));
  assert(check.ok, JSON.stringify(check));
  return check;
}

async function refused(subject: ReturnType<typeof aws>, id = APP_ID, secret = APP_SECRET) {
  const check = await subject.issuer.checkAccount(id, new Secret(secret));
  assert(!check.ok, JSON.stringify(check));
  return check;
}

describe("AWS IAM issuer", () => {
  test("checks the vault's pair, then creates a key for the same user, always naming the user", async () => {
    const subject = aws();
    const check = await checked(subject);
    expect(check.currentId).toBe(APP_ID);
    expect(check.facts).toBe(
      "the vault holds access key AKIAAPPAPPAPPAPP0001 of IAM user app in account 123456789012",
    );
    expect(check.notes?.create).toBe("for IAM user app");
    const created = await subject.issuer.create();
    expect(created.id).toBe(NEW_ID);
    expect(created.secret.equals(new Secret("new/secret/1x"))).toBe(true);
    expect(subject.actions.map((a) => `${a.signer} ${a.action}`)).toEqual([
      `${APP_ID} GetCallerIdentity`,
      `${ADMIN_ID} GetCallerIdentity`,
      `${ADMIN_ID} ListAccessKeys`,
      `${ADMIN_ID} CreateAccessKey`,
      `${NEW_ID} GetCallerIdentity`,
    ]);
    expect(
      subject.actions.filter((a) => a.signer === ADMIN_ID && a.action !== "GetCallerIdentity"),
    ).toSatisfy((calls: { params: Record<string, string> }[]) =>
      calls.every((c) => c.params.UserName === "app"),
    );
    expect(subject.issuer.dashboard()).toBe(
      "https://console.aws.amazon.com/iam/home#/users/details/app?section=security_credentials",
    );
  });

  test("names a user with a path by its name alone", async () => {
    const subject = aws([ADMIN_KEY, { ...APP_KEY, path: "/division/team/" }]);
    const check = await checked(subject);
    expect(check.facts).toContain("of IAM user app in account");
    expect(subject.actions.at(-1)?.params.UserName).toBe("app");
  });

  test("retries until the new key works, since IAM is eventually consistent", async () => {
    const subject = aws(undefined, { unready: 3 });
    await checked(subject);
    const created = await subject.issuer.create();
    expect(created.id).toBe(NEW_ID);
    expect(subject.sleeps).toEqual([2000, 2000, 2000]);
    expect(subject.effects).toEqual([`aws create app/${NEW_ID}`]);
  });

  test("deletes a new key that never starts working, and says nothing changed", async () => {
    const subject = aws(undefined, { unready: 100 });
    await checked(subject);
    const failed = await subject.issuer.create().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NothingChanged);
    expect(String(failed)).toContain(
      "AWS didn't accept the new access key AKIANEW0000000000001 within 60 seconds, so keypin deleted it",
    );
    expect(subject.effects).toEqual([`aws create app/${NEW_ID}`, `aws delete app/${NEW_ID}`]);
  });

  test("revokes by deactivating, then deleting", async () => {
    const subject = aws();
    await checked(subject);
    expect(await subject.issuer.revoke(APP_ID)).toBe("revoked");
    expect(subject.actions.slice(-2).map((a) => [a.action, a.params])).toEqual([
      ["UpdateAccessKey", { UserName: "app", AccessKeyId: APP_ID, Status: "Inactive" }],
      ["DeleteAccessKey", { UserName: "app", AccessKeyId: APP_ID }],
    ]);
    expect(subject.effects).toEqual([`aws delete app/${APP_ID}`]);
    expect(await subject.issuer.revoke(APP_ID)).toBe("already gone");
  });

  test("a revoke that stopped after deactivating finishes on the next run", async () => {
    const subject = aws(undefined, { failDelete: true });
    await checked(subject);
    await expect(subject.issuer.revoke(APP_ID)).rejects.toThrow(
      "keypin deactivated access key AKIAAPPAPPAPPAPP0001, so it no longer works, but couldn't delete it",
    );
    expect(subject.world.load().keys.find((k) => k.id === APP_ID)?.status).toBe("Inactive");
    subject.fake.failDelete = false;
    expect(await subject.issuer.revoke(APP_ID)).toBe("revoked");
    expect(subject.world.load().keys.some((k) => k.id === APP_ID)).toBe(false);
  });

  test("on resume, checks the new pair and revokes the old key it still lists", async () => {
    const subject = aws([ADMIN_KEY, APP_KEY, { id: NEW_ID, secret: "new/secret/1x", user: "app" }]);
    const check = await checked(subject, NEW_ID, "new/secret/1x");
    expect(check.currentId).toBe(NEW_ID);
    expect(await subject.issuer.revoke(APP_ID)).toBe("revoked");
  });

  test("stops before creating when the user already has a second key", async () => {
    const other: FakeAwsKey = {
      id: "AKIAOTHEROTHEROTHER1",
      secret: "other",
      user: "app",
      created: "2026-01-02T03:04:05Z",
    };
    const subject = aws([ADMIN_KEY, APP_KEY, other]);
    const check = await checked(subject);
    expect(check.notes?.create).toBe(
      "for IAM user app, who also has key AKIAOTHEROTHEROTHER1, created 2026-01-02; AWS allows two keys per user",
    );
    const failed = await subject.issuer.create().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NothingChanged);
    expect(String(failed)).toContain(
      "aws iam delete-access-key --user-name app --access-key-id AKIAOTHEROTHEROTHER1",
    );
    expect(subject.effects).toEqual([]);
  });

  test("after revoking keypin's unsaved key, the slot is free for a new one", async () => {
    const orphan: FakeAwsKey = { id: "AKIAORPHANORPHANORP1", secret: "orphan", user: "app" };
    const subject = aws([ADMIN_KEY, APP_KEY, orphan]);
    await checked(subject);
    expect(await subject.issuer.revoke(orphan.id)).toBe("revoked");
    const created = await subject.issuer.create();
    expect(created.id).toBe(NEW_ID);
  });

  test("a full user that AWS reports at create time stops with nothing changed", async () => {
    const subject = aws();
    await checked(subject);
    const world = subject.world.load();
    subject.world.save({
      ...world,
      keys: [...world.keys, { id: "AKIALATELATELATELAT1", secret: "late", user: "app" }],
    });
    await expect(subject.issuer.create()).rejects.toBeInstanceOf(NothingChanged);
  });

  test("never retries a create whose reply was lost, and says how to find the extra key", async () => {
    const subject = aws(undefined, { loseCreated: true });
    await checked(subject);
    await expect(subject.issuer.create()).rejects.toThrow("fetch failed");
    expect(subject.actions.filter((a) => a.action === "CreateAccessKey")).toHaveLength(1);
    expect(subject.issuer.lostCreate()).toBe(
      "AWS may have made an access key for IAM user app before the reply was lost, and IAM keys have no name to find it by. Run aws iam list-access-keys --user-name app: keep AKIAAPPAPPAPPAPP0001, the vault's key, and delete the other one with aws iam delete-access-key --user-name app --access-key-id <ID> before you run this again. Until then the user has no room for a new key.",
    );
  });

  test("a vault secret that doesn't match its ID is refused before anything else", async () => {
    const subject = aws();
    const check = await refused(subject, APP_ID, "wrong/secret");
    expect(check.facts).toBe("AWS answered HTTP 403 SignatureDoesNotMatch");
    expect(check.reason).toBe(
      "the vault's secret isn't the secret of access key AKIAAPPAPPAPPAPP0001, or this computer's clock is off",
    );
    expect(subject.actions.map((a) => a.action)).toEqual(["GetCallerIdentity"]);
  });

  test("a deleted or deactivated vault key is refused", async () => {
    const subject = aws([ADMIN_KEY, { ...APP_KEY, status: "Inactive" }]);
    const check = await refused(subject);
    expect(check.reason).toContain("AWS doesn't accept access key AKIAAPPAPPAPPAPP0001");
  });

  test.each([
    ["no key ID", null, "keypin doesn't know the vault key's access key ID"],
    [
      "temporary credentials",
      "ASIAAPPAPPAPPAPP0001",
      "the vault holds temporary credentials ASIAAPPAPPAPPAPP0001",
    ],
    ["not a key ID", "app-key-id", "the vault's key ID isn't an AWS access key ID"],
  ])("refuses %s in the key ID entry without calling AWS", async (_, id, facts) => {
    const subject = aws();
    const check = await subject.issuer.checkAccount(id, new Secret(APP_SECRET));
    assert(!check.ok);
    expect(check.facts).toBe(facts);
    expect(subject.actions).toEqual([]);
  });

  test("refuses a root user key", async () => {
    const subject = aws([ADMIN_KEY, { ...APP_KEY, user: null }]);
    const check = await refused(subject);
    expect(check.facts).toBe(
      "the vault holds access key AKIAAPPAPPAPPAPP0001 of the root user of account 123456789012",
    );
    expect(check.reason).toContain("root user key");
  });

  test("refuses the rotating key as its own admin", async () => {
    const subject = aws(undefined, {}, accessKeyJson(APP_ID, APP_SECRET));
    const check = await refused(subject);
    expect(check.reason).toBe(
      "deleting the old key would leave the admin item with a key that no longer works",
    );
    expect(subject.actions).toEqual([]);
  });

  test("refuses an admin key of the same user, which takes the second slot", async () => {
    const subject = aws([{ ...ADMIN_KEY, user: "app" }, APP_KEY]);
    const check = await refused(subject);
    expect(check.reason).toBe(
      "an IAM user has at most two access keys, and the admin key takes app's second one, so there's no room for the new key",
    );
  });

  test("refuses an admin key from another account", async () => {
    const subject = aws([{ ...ADMIN_KEY, account: "999999999999" }, APP_KEY]);
    const check = await refused(subject);
    expect(check.reason).toBe(
      "the admin key manages account 999999999999, and the vault's key is in account 123456789012",
    );
  });

  test("refuses a root admin key", async () => {
    const subject = aws([{ ...ADMIN_KEY, user: null }, APP_KEY]);
    const check = await refused(subject);
    expect(check.reason).toBe("keypin signs in to AWS with an IAM user's key, not the root user's");
  });

  test("refuses an admin key AWS doesn't accept", async () => {
    const subject = aws([APP_KEY]);
    const check = await refused(subject);
    expect(check.reason).toBe("AWS doesn't accept the admin key: it was deleted or deactivated");
  });

  test("refuses an admin key that can't list the user's keys", async () => {
    const subject = aws(undefined, { denied: ["ListAccessKeys"] });
    const check = await refused(subject);
    expect(check.reason).toBe(
      "the admin key can't list the access keys of IAM user app (AWS ListAccessKeys returned HTTP 403 AccessDenied)",
    );
  });

  test("an admin key that can't create keys stops with nothing changed", async () => {
    const subject = aws(undefined, { denied: ["CreateAccessKey"] });
    await checked(subject);
    await expect(subject.issuer.create()).rejects.toBeInstanceOf(NothingChanged);
  });

  test("an admin key that can't deactivate a key says to delete it by hand", async () => {
    const subject = aws(undefined, { denied: ["UpdateAccessKey"] });
    await checked(subject);
    await expect(subject.issuer.revoke(APP_ID)).rejects.toThrow(
      "the admin key can't deactivate access key AKIAAPPAPPAPPAPP0001 of IAM user app",
    );
  });

  test.each([
    ["no JSON", "AKIAADMINADMINADMIN1", "the admin item holds no AWS access key JSON"],
    [
      "temporary credentials",
      JSON.stringify({
        AccessKeyId: "ASIAADMINADMINADMIN1",
        SecretAccessKey: "s",
        SessionToken: "t",
      }),
      "the admin item holds temporary credentials ASIAADMINADMINADMIN1",
    ],
    [
      "a session token with a long-term ID",
      JSON.stringify({ AccessKeyId: ADMIN_ID, SecretAccessKey: "s", SessionToken: "t" }),
      `the admin item holds temporary credentials ${ADMIN_ID}`,
    ],
    [
      "an ID that isn't an access key ID",
      JSON.stringify({ AccessKeyId: "admin", SecretAccessKey: "s" }),
      "the admin item's AccessKeyId isn't an AWS access key ID",
    ],
  ])("refuses an admin item with %s", async (_, admin, facts) => {
    const subject = aws(undefined, {}, admin);
    const check = await refused(subject);
    expect(check.facts).toBe(facts);
    expect(subject.actions).toEqual([]);
  });

  test("reads the admin key from create-access-key's JSON, or the AccessKey object alone", async () => {
    const bare = JSON.stringify({ AccessKeyId: ADMIN_ID, SecretAccessKey: ADMIN_SECRET });
    await checked(aws(undefined, {}, bare));
    await checked(aws());
  });

  test("create and revoke refuse until checkAccount passes", async () => {
    const subject = aws();
    await refused(subject, APP_ID, "wrong");
    await expect(subject.issuer.create()).rejects.toThrow("checkAccount");
    await expect(subject.issuer.revoke(APP_ID)).rejects.toThrow("checkAccount");
  });
});

describe("the aws issuer in keypin.toml", () => {
  const map = (issuer: string) => `[1password]
account = "my.1password.com"

[keys.AWS_SECRET_ACCESS_KEY.prod]
from = "op://Private/app aws secret/credential"
${issuer}

[keys.AWS_ACCESS_KEY_ID.prod]
from = "op://Private/app aws key id/credential"
`;

  test("names the key that holds the access key ID", () => {
    const parsed = parseMap(
      map(`[keys.AWS_SECRET_ACCESS_KEY.prod.issuer]
kind = "aws"
admin = "op://Private/aws admin/credential"
key_id = "AWS_ACCESS_KEY_ID"`),
      "keypin.toml",
      [],
      [awsIssuer],
      [onePasswordVault],
    );
    assert(parsed.ok, JSON.stringify(parsed));
    const entry = parsed.map.keys[0]?.environments.prod;
    expect(entry?.idKey).toBe("AWS_ACCESS_KEY_ID");
    expect(entry?.issuer?.kind).toBe("aws");
  });

  test("requires key_id", () => {
    const parsed = parseMap(
      map(`[keys.AWS_SECRET_ACCESS_KEY.prod.issuer]
kind = "aws"
admin = "op://Private/aws admin/credential"`),
      "keypin.toml",
      [],
      [awsIssuer],
      [onePasswordVault],
    );
    assert(!parsed.ok);
    expect(parsed.errors.join("\n")).toContain('"key_id"');
  });
});
