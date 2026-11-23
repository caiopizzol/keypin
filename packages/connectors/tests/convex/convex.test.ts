import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, readSecretspec, Secret } from "@keypin/core";
import { expectNoneOf } from "@keypin/core/testing";
import {
  ConvexEnvDestination,
  ConvexSignInFailed,
  convexDeployment,
  convexSignIn,
  TOKEN_VARIABLE,
} from "../../src/convex/index";
import { convexFetch, type FakeConvex } from "../../src/convex/testing";
import { onePasswordVault } from "../../src/onepassword/index";

const VALUE = "convex-value-sentinel-7b3e";
const SECRET_PART = "key-sentinel-31fa";
const KEY = `prod:happy-animal-123|${SECRET_PART}`;
const URL = "https://happy-animal-123.convex.cloud";

async function caught(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(outcome instanceof Error, "expected a rejection");
  return outcome;
}

function setup({
  key = KEY,
  url = URL,
  ...over
}: Partial<FakeConvex> & { key?: string; url?: string } = {}) {
  const state: FakeConvex = {
    deployments: {
      "happy-animal-123": { host: "happy-animal-123.convex.cloud" },
      "quiet-otter-456": { host: "quiet-otter-456.eu-west-1.convex.cloud" },
    },
    keys: {
      [KEY]: { deployment: "happy-animal-123", envWrite: true },
      [`dev:quiet-otter-456|${SECRET_PART}`]: { deployment: "quiet-otter-456", envWrite: true },
    },
    ...over,
  };
  const convex = convexFetch(state);
  const requests: { method: string; url: string; body: string }[] = [];
  const fetch: Fetch = async (u, init) => {
    requests.push({ method: init.method, url: u, body: init.body ?? "" });
    return convex.fetch(u, init);
  };
  const destination = new ConvexEnvDestination({ url, key: async () => key, fetch });
  return { state, convex, requests, destination };
}

describe("writing", () => {
  test("sets the variable on the pinned deployment with the deploy key", async () => {
    const { destination, convex, requests } = setup();
    expect(await destination.checkAccount()).toMatchObject({
      ok: true,
      publisher: "a prod deploy key",
      destinationAccount: "happy-animal-123",
    });
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(convex.value("happy-animal-123", "API_KEY")).toBe(VALUE);
    expect(evidence).toMatchObject({ action: "set", secret: "API_KEY" });
    expect(String(evidence.note)).toContain("invalidates every subscription");
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe(`${URL}/api/v1/update_environment_variables`);
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      changes: [{ name: "API_KEY", value: VALUE }],
    });
    expect(requests.map((r) => r.url).some((u) => u.includes("list_environment"))).toBe(false);
    expectNoneOf([VALUE, SECRET_PART], evidence, convex.effects, destination.describe());
  });

  test("a deployment in another region is reached at its own URL", async () => {
    const { destination, convex } = setup({
      key: `dev:quiet-otter-456|${SECRET_PART}`,
      url: "https://quiet-otter-456.eu-west-1.convex.cloud",
    });
    expect((await destination.checkAccount()).ok).toBe(true);
    await destination.write("API_KEY", new Secret(VALUE));
    expect(convex.value("quiet-otter-456", "API_KEY")).toBe(VALUE);
  });
});

describe("refusals", () => {
  test("a deploy key for another deployment fails the check, before any request", async () => {
    const { destination, requests } = setup({ key: `dev:quiet-otter-456|${SECRET_PART}` });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe(
      "the deploy key is for deployment quiet-otter-456, not happy-animal-123",
    );
    expect(check.destinationAccount).toBe("quiet-otter-456");
    expect(check.fix).toContain("check url in secretspec.toml");
    expect(requests).toEqual([]);
    expectNoneOf([SECRET_PART], check);
  });

  test.each([
    [`happy-animal-123|${SECRET_PART}`, "holds an admin key"],
    [`project:acme:billing|${SECRET_PART}`, "holds a project key"],
    [`preview:acme:billing|${SECRET_PART}`, "holds a preview key"],
    [SECRET_PART, "doesn't hold a deploy key for one deployment"],
  ])("refuses %s without a request", async (key, reason) => {
    const { destination, requests } = setup({ key });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toContain(reason);
    expect(check.fix).toContain("deployment:env:write");
    expect(requests).toEqual([]);
    expectNoneOf([SECRET_PART], check);
  });

  test("a key the deployment doesn't know fails the check", async () => {
    const { destination } = setup({ keys: {} });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("deployment happy-animal-123 refused the deploy key");
  });

  test("a key without deployment:env:write passes the check but its write says what to add", async () => {
    const { destination, convex } = setup({
      keys: { [KEY]: { deployment: "happy-animal-123", envWrite: false } },
    });
    expect((await destination.checkAccount()).ok).toBe(true);
    const failed = await caught(destination.write("API_KEY", new Secret(VALUE)));
    expect(failed.message).toContain("can't change environment variables");
    expect(failed.message).toContain("deployment:env:write");
    expect(failed.message).toContain("HTTP 403 OperationNotPermitted");
    expect(convex.effects).toEqual([]);
  });

  test.each([VALUE, 'line-one\nline-two "quoted"', '{"client_secret":"s3cr3t"}'])(
    "a refused write names the status and code, never Convex's message: %j",
    async (value) => {
      const { destination } = setup({ failWrites: true });
      await destination.checkAccount();
      const failed = await caught(destination.write("API_KEY", new Secret(value)));
      expect(failed.message).toContain("returned HTTP 400 EnvironmentVariableValueTooLarge");
      expect(failed.message).not.toContain("could not store");
      expectNoneOf([value, JSON.stringify(value).slice(1, -1), SECRET_PART], failed);
    },
  );

  test("a value over 8 KiB isn't sent", async () => {
    const { destination, requests } = setup();
    await destination.checkAccount();
    const failed = await caught(destination.write("API_KEY", new Secret("x".repeat(8193))));
    expect(failed.message).toContain("up to 8 KiB");
    expect(requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  test("a URL that isn't a deployment's is refused when constructing", () => {
    expect(
      () => new ConvexEnvDestination({ url: "https://api.example.com", key: async () => KEY }),
    ).toThrow("isn't a Convex deployment URL");
  });
});

describe("sign-in", () => {
  test("reads the deploy key from KEYPIN_CONVEX_DEPLOY_KEY", async () => {
    expect(await convexSignIn({ [TOKEN_VARIABLE]: ` ${KEY} ` }).key()).toBe(KEY);
  });

  test("without it, says how to make one, and that CONVEX_DEPLOY_KEY isn't used", async () => {
    const failed = await caught(convexSignIn({ CONVEX_DEPLOY_KEY: KEY }).key());
    assert(failed instanceof ConvexSignInFailed);
    expect(failed.message).toContain(`${TOKEN_VARIABLE}, which isn't set`);
    expect(failed.message).toContain(
      "CONVEX_DEPLOY_KEY is set, but keypin doesn't sign in with it",
    );
    expectNoneOf([SECRET_PART], failed);
  });

  test("an empty key is refused", async () => {
    const failed = await caught(convexSignIn({ [TOKEN_VARIABLE]: " " }).key());
    expect(failed.message).toContain("is set but empty");
  });

  const target = { to: "convex-deployment", account: "happy-animal-123", url: URL } as const;

  test("the account check stops without a key, before any request", async () => {
    const destination = convexDeployment.connect(target, { signInEnv: {} });
    const failed = await caught(destination.checkAccount());
    assert(failed instanceof ConvexSignInFailed);
  });

  test("check lists the sign-in step only when a key publishes to Convex", async () => {
    const project = { folder: "/p", used: false };
    const missing = await convexDeployment.prerequisites?.(
      { ...project, targets: [target] },
      { env: {} },
    );
    expect(missing?.map((p) => p.status)).toEqual(["not logged in"]);
    expect(
      await convexDeployment.prerequisites?.({ ...project, targets: [] }, { env: {} }),
    ).toEqual([]);
    const set = { env: { [TOKEN_VARIABLE]: KEY } };
    expect(await convexDeployment.prerequisites?.({ ...project, targets: [target] }, set)).toEqual(
      [],
    );
  });
});

describe("secretspec.toml", () => {
  const map = (url: string, key = "API_KEY") =>
    readSecretspec(
      `[project]\nname = "web"\nrevision = "1.0"\n\n[profiles.prod]\n${key} = { description = "a key", providers = ["onepassword://my.1password.com@Private"], ref = { item = "web", field = "credential" } }\n\n[[tool.keypin.prod.${key}.publish]]\nto = "convex-deployment"\nurl = "${url}"\n`,
      "secretspec.toml",
      [convexDeployment],
      [],
      [onePasswordVault],
    );
  const errors = (parsed: ReturnType<typeof map>) => (parsed.ok ? "" : parsed.errors.join("\n"));

  test("takes the deployment URL, and pins its name", () => {
    const parsed = map(`${URL}/`);
    expect(parsed.ok ? parsed.map.keys[0]?.environments.prod?.publish : parsed.errors).toEqual([
      { to: "convex-deployment", account: "happy-animal-123", url: URL },
    ]);
    expect(map("https://quiet-otter-456.eu-west-1.convex.cloud").ok).toBe(true);
  });

  test("refuses a site URL, a custom domain or a deployment name", () => {
    for (const url of [
      "https://happy-animal-123.convex.site",
      "https://api.example.com",
      "happy-animal-123",
      "http://happy-animal-123.convex.cloud",
    ])
      expect(errors(map(url))).toContain(`field "url" must be the deployment's convex.cloud URL`);
  });

  test("refuses a name Convex sets itself, or one it can't hold", () => {
    expect(errors(map(URL, "CONVEX_SITE_URL"))).toContain("Convex sets CONVEX_SITE_URL itself");
    expect(errors(map(URL, "_TOKEN"))).toContain("Convex names must start with a letter");
  });

  test("ids round-trip, and each deployment is its own destination", () => {
    const target = { to: "convex-deployment", account: "happy-animal-123", url: URL } as const;
    expect(convexDeployment.fromId(convexDeployment.id(target), "happy-animal-123")).toEqual(
      target,
    );
    const other = {
      ...target,
      account: "quiet-otter-456",
      url: "https://quiet-otter-456.eu-west-1.convex.cloud",
    };
    expect(convexDeployment.fromId(convexDeployment.id(other), "quiet-otter-456")).toEqual(other);
    expect(convexDeployment.secretId(target, "K")).not.toBe(convexDeployment.secretId(other, "K"));
  });
});
