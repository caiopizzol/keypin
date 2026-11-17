import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, parseMap, Secret } from "@keypin/core";
import { expectNoneOf } from "@keypin/core/testing";
import {
  FlySecretsDestination,
  FlySignInFailed,
  flyApp,
  flySignIn,
  TOKEN_VARIABLE,
} from "../../src/fly/index";
import { type FakeFly, flyFetch } from "../../src/fly/testing";
import { onePasswordVault } from "../../src/onepassword/index";

const VALUE = "fly-value-sentinel-5c1d";
const SECRET_PART = "fm2_token-sentinel-9e4a";
const DEPLOY = `FlyV1 ${SECRET_PART}`;
const ORG = "org-token-sentinel-2b7f";
const READ_ONLY = "read-only-sentinel-8d0c";

async function caught(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(outcome instanceof Error, "expected a rejection");
  return outcome;
}

function setup({
  token = DEPLOY,
  app = "billing-api",
  org,
  ...over
}: Partial<FakeFly> & { token?: string; app?: string; org?: string } = {}) {
  const state: FakeFly = {
    apps: {
      "billing-api": { org: "acme" },
      "billing-worker": { org: "acme" },
      "other-api": { org: "elsewhere" },
    },
    tokens: {
      [DEPLOY]: { org: "acme", apps: ["billing-api"] },
      [ORG]: { org: "acme" },
      [READ_ONLY]: { org: "acme", readOnly: true },
    },
    ...over,
  };
  const fly = flyFetch(state);
  const requests: { method: string; url: string; body: string; auth: string }[] = [];
  const fetch: Fetch = async (u, init) => {
    requests.push({
      method: init.method,
      url: u,
      body: init.body ?? "",
      auth: init.headers.Authorization ?? "",
    });
    return fly.fetch(u, init);
  };
  const destination = new FlySecretsDestination({ app, org, token: async () => token, fetch });
  return { state, fly, requests, destination };
}

describe("writing", () => {
  test("sets the secret on the pinned app with a deploy token, and deploys nothing", async () => {
    const { destination, fly, requests } = setup();
    expect(await destination.checkAccount()).toMatchObject({
      ok: true,
      publisher: "a Fly.io deploy token for billing-api",
      expected: "billing-api",
      destinationAccount: "billing-api",
    });
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(fly.value("billing-api", "API_KEY")).toBe(VALUE);
    expect(evidence).toMatchObject({
      secret: "API_KEY",
      action: "set",
      version: 1,
      deployed: false,
    });
    expect(String(evidence.note)).toContain("fly secrets deploy");
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe("https://api.machines.dev/v1/apps/billing-api/secrets/API_KEY");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ value: VALUE });
    expect(requests.every((r) => r.auth === `Bearer ${DEPLOY}`)).toBe(true);
    expect(requests.some((r) => r.url.includes("/machines"))).toBe(false);
    expect(fly.effects).toEqual(["fly set billing-api API_KEY"]);
    expectNoneOf([VALUE, SECRET_PART], evidence, fly.effects, destination.describe());
  });

  test("an org token reaches every app in its organization, and the pinned org matches", async () => {
    const { destination, fly } = setup({ token: ORG, app: "billing-worker", org: "acme" });
    expect(await destination.checkAccount()).toMatchObject({
      ok: true,
      publisher: "a Fly.io org token for acme",
    });
    await destination.write("API_KEY", new Secret(VALUE));
    expect(fly.value("billing-worker", "API_KEY")).toBe(VALUE);
  });
});

describe("refusals", () => {
  test("a deploy token for another app fails the check before asking for the app", async () => {
    const { destination, requests } = setup({ app: "billing-worker" });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("the deploy token is for billing-api, not billing-worker");
    expect(check.fix).toContain("fly tokens create deploy -a billing-worker");
    expect(requests.map((r) => r.url)).toEqual(["https://api.machines.dev/v1/tokens/current"]);
    expectNoneOf([SECRET_PART], check);
  });

  test("an org token for another organization can't reach the app", async () => {
    const { destination } = setup({ token: ORG, app: "other-api" });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("the token can't reach the app other-api");
    expect(check.fix).toContain("check app in keypin.toml");
  });

  test("an app in another organization than the map pins fails the check", async () => {
    const { destination } = setup({ token: ORG, org: "acme-staging" });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe(
      "the app billing-api belongs to the organization acme, not acme-staging",
    );
    expect(check.fix).toBe("check org in keypin.toml");
  });

  test("a token Fly.io doesn't know fails the check", async () => {
    const { destination } = setup({ tokens: {} });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe(`Fly.io refused the token in ${TOKEN_VARIABLE}`);
    expect(check.publisher).toBe("unknown");
  });

  test("a read-only token passes the check but its write says to use a deploy or org token", async () => {
    const { destination, fly } = setup({ token: READ_ONLY });
    expect((await destination.checkAccount()).ok).toBe(true);
    const failed = await caught(destination.write("API_KEY", new Secret(VALUE)));
    expect(failed.message).toContain("a read-only token can't");
    expect(failed.message).toContain("returned HTTP 403");
    expect(fly.effects).toEqual([]);
  });

  test.each([VALUE, 'line-one\nline-two "quoted"', '{"client_secret":"s3cr3t"}'])(
    "a refused write names the status, never Fly.io's message: %j",
    async (value) => {
      const { destination } = setup({ failWrites: true });
      await destination.checkAccount();
      const failed = await caught(destination.write("API_KEY", new Secret(value)));
      expect(failed.message).toBe("Fly.io POST /apps/{app}/secrets/{name} returned HTTP 400");
      expectNoneOf([value, JSON.stringify(value).slice(1, -1), SECRET_PART], failed);
    },
  );

  test("a name Fly.io can't hold isn't sent", async () => {
    const { destination, requests } = setup();
    await destination.checkAccount();
    const failed = await caught(destination.write("API-KEY", new Secret(VALUE)));
    expect(failed.message).toContain("letters, digits and _");
    expect(requests.filter((r) => r.method === "POST")).toEqual([]);
  });
});

describe("sign-in", () => {
  test("reads the token from KEYPIN_FLY_API_TOKEN, FlyV1 prefix and all", async () => {
    expect(await flySignIn({ [TOKEN_VARIABLE]: ` ${DEPLOY} ` }).token()).toBe(DEPLOY);
  });

  test("without it, says how to make one, and that FLY_API_TOKEN isn't used", async () => {
    const failed = await caught(flySignIn({ FLY_API_TOKEN: DEPLOY }).token());
    assert(failed instanceof FlySignInFailed);
    expect(failed.message).toContain(`${TOKEN_VARIABLE}, which isn't set`);
    expect(failed.message).toContain("FLY_API_TOKEN is set, but keypin doesn't sign in with it");
    expect(failed.message).toContain("fly tokens create deploy");
    expectNoneOf([SECRET_PART], failed);
  });

  test("an empty token is refused", async () => {
    const failed = await caught(flySignIn({ [TOKEN_VARIABLE]: " " }).token());
    expect(failed.message).toContain("is set but empty");
  });

  const target = { to: "fly-app", account: "billing-api", app: "billing-api" } as const;

  test("the account check stops without a token, before any request", async () => {
    const destination = flyApp.connect(target, { signInEnv: {} });
    const failed = await caught(destination.checkAccount());
    assert(failed instanceof FlySignInFailed);
  });

  test("check lists the sign-in step only when a key publishes to Fly.io", async () => {
    const project = { folder: "/p", used: false };
    const missing = await flyApp.prerequisites?.({ ...project, targets: [target] }, { env: {} });
    expect(missing?.map((p) => p.status)).toEqual(["not logged in"]);
    expect(await flyApp.prerequisites?.({ ...project, targets: [] }, { env: {} })).toEqual([]);
    const set = { env: { [TOKEN_VARIABLE]: DEPLOY } };
    expect(await flyApp.prerequisites?.({ ...project, targets: [target] }, set)).toEqual([]);
  });
});

describe("keypin.toml", () => {
  const map = (fields: string, key = "API_KEY") =>
    parseMap(
      `[1password]\naccount = "my.1password.com"\n\n[keys.${key}.prod]\nfrom = "op://Private/web/credential"\n\n[[keys.${key}.prod.publish]]\nto = "fly-app"\n${fields}\n`,
      "keypin.toml",
      [flyApp],
      [],
      [onePasswordVault],
    );
  const errors = (parsed: ReturnType<typeof map>) => (parsed.ok ? "" : parsed.errors.join("\n"));
  const targets = (parsed: ReturnType<typeof map>) =>
    parsed.ok ? parsed.map.keys[0]?.environments.prod?.publish : parsed.errors;

  test("takes the app, and pins it; org is optional", () => {
    expect(targets(map(`app = "billing-api"`))).toEqual([
      { to: "fly-app", account: "billing-api", app: "billing-api" },
    ]);
    expect(targets(map(`app = "billing-api"\norg = "acme"`))).toEqual([
      { to: "fly-app", account: "billing-api", app: "billing-api", org: "acme" },
    ]);
  });

  test("refuses a missing app, an app or org that isn't a Fly.io name, and other fields", () => {
    expect(errors(map(`org = "acme"`))).toContain(`"app"`);
    expect(errors(map(`app = "Billing API"`))).toContain(`field "app" must be a Fly.io app name`);
    expect(errors(map(`app = "billing-api"\norg = "Acme Inc"`))).toContain(
      `field "org" must be a Fly.io organization slug`,
    );
    expect(errors(map(`app = "billing-api"\nmachine = "x"`))).not.toBe("");
  });

  test("refuses a name Fly.io can't hold", () => {
    expect(errors(map(`app = "billing-api"`, "API-KEY"))).toContain(
      "Fly.io names use only letters, digits and _",
    );
  });

  test("ids round-trip, and each app is its own destination", () => {
    const target = { to: "fly-app", account: "billing-api", app: "billing-api" } as const;
    expect(flyApp.fromId(flyApp.id(target), "billing-api")).toEqual(target);
    const other = { ...target, account: "billing-worker", app: "billing-worker" };
    expect(flyApp.secretId(target, "K")).not.toBe(flyApp.secretId(other, "K"));
    expect(flyApp.checkId({ ...target, org: "acme" })).not.toBe(flyApp.checkId(target));
  });
});
