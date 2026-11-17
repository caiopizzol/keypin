import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, parseMap, Secret } from "@keypin/core";
import { expectNoneOf } from "@keypin/core/testing";
import { onePasswordVault } from "../../src/onepassword/index";
import {
  RailwaySignInFailed,
  RailwayVariablesDestination,
  railwayService,
  railwaySignIn,
  TOKEN_VARIABLE,
} from "../../src/railway/index";
import { type FakeRailway, railwayFetch } from "../../src/railway/testing";

const VALUE = "railway-value-sentinel-7c2b";
const TOKEN = "railway-token-sentinel-41fa";
const PROJECT = "1d01c0c0-4554-4747-93b8-34ce3448ab95";
const OTHER = "2e02d1d1-5665-4858-a4c9-45df4459bc06";

async function caught(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(outcome instanceof Error, "expected a rejection");
  return outcome;
}

function setup(
  fake: Partial<FakeRailway> = {},
  { environment = "production", service = "api", project = PROJECT } = {},
) {
  const state: FakeRailway = {
    email: "alice@example.com",
    projects: {
      [PROJECT]: {
        environments: [
          { id: "env-prod", name: "production" },
          { id: "env-stage", name: "staging" },
        ],
        services: [
          { id: "svc-api", name: "api" },
          { id: "svc-web", name: "web" },
        ],
      },
    },
    ...fake,
  };
  const railway = railwayFetch(state);
  const requests: { headers: Record<string, string>; body: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ headers: init.headers, body: init.body ?? "" });
    return railway.fetch(url, init);
  };
  const destination = new RailwayVariablesDestination({
    project,
    environment,
    service,
    token: async () => TOKEN,
    fetch,
  });
  return { state, railway, requests, destination };
}

describe("writing", () => {
  test("upserts the service variable without deploying, and says to deploy", async () => {
    const { destination, railway, requests } = setup();
    expect((await destination.checkAccount()).ok).toBe(true);
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(railway.value("env-prod", "svc-api", "API_KEY")).toBe(VALUE);
    expect(railway.effects).toEqual([`railway set ${PROJECT}/env-prod/svc-api API_KEY`]);
    const upsert: unknown = JSON.parse(requests.at(-1)?.body ?? "{}");
    expect(upsert).toHaveProperty("variables.input", {
      projectId: PROJECT,
      environmentId: "env-prod",
      serviceId: "svc-api",
      name: "API_KEY",
      value: VALUE,
      skipDeploys: true,
    });
    expect(requests.at(-1)?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(evidence).toMatchObject({ environmentId: "env-prod", serviceId: "svc-api" });
    expect(String(evidence.note)).toContain("next deploy");
    expectNoneOf([VALUE, TOKEN], evidence, railway.effects);
  });

  test("takes the environment and service by ID too", async () => {
    const { destination, railway } = setup({}, { environment: "env-stage", service: "svc-web" });
    expect((await destination.checkAccount()).ok).toBe(true);
    await destination.write("API_KEY", new Secret(VALUE));
    expect(railway.value("env-stage", "svc-web", "API_KEY")).toBe(VALUE);
  });

  test("a project token for the environment writes with the Project-Access-Token header", async () => {
    const { destination, railway, requests } = setup({
      projectToken: { projectId: PROJECT, environmentId: "env-prod" },
    });
    const check = await destination.checkAccount();
    expect(check).toMatchObject({ ok: true, publisher: "a Railway project token" });
    await destination.write("API_KEY", new Secret(VALUE));
    expect(railway.value("env-prod", "svc-api", "API_KEY")).toBe(VALUE);
    expect(requests.at(-1)?.headers["Project-Access-Token"]).toBe(TOKEN);
    expect(requests.at(-1)?.headers.Authorization).toBeUndefined();
  });

  test("a workspace token, which can't read its user, still writes", async () => {
    const { destination } = setup({ email: null });
    const check = await destination.checkAccount();
    expect(check).toMatchObject({ ok: true, publisher: "a Railway workspace token" });
  });
});

describe("refusals", () => {
  test("a project the token can't reach fails the check", async () => {
    const { destination } = setup({ projects: {} });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe(`the token can't reach the project ${PROJECT}`);
    expect(check.fix).toContain(TOKEN_VARIABLE);
  });

  test("a refused token fails the check with how to make one", async () => {
    const { destination } = setup({ invalidToken: true });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe(`the token can't reach the project ${PROJECT}`);
    expect(check.fix).toContain("https://railway.com/account/tokens");
  });

  test("an environment or service the project doesn't have fails the check", async () => {
    const missingEnvironment = await setup(
      {},
      { environment: "preview" },
    ).destination.checkAccount();
    assert(!missingEnvironment.ok);
    expect(missingEnvironment.reason).toBe("the project has no environment preview");
    const missingService = await setup({}, { service: "worker" }).destination.checkAccount();
    assert(!missingService.ok);
    expect(missingService.reason).toBe("the project has no service worker");
  });

  test("two services with the same name ask for the ID", async () => {
    const { destination } = setup({
      projects: {
        [PROJECT]: {
          environments: [{ id: "env-prod", name: "production" }],
          services: [
            { id: "svc-1", name: "api" },
            { id: "svc-2", name: "api" },
          ],
        },
      },
    });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("the project has 2 services named api; use its ID");
  });

  test("a restricted environment the token can't reach fails the check", async () => {
    const { destination } = setup({
      projects: {
        [PROJECT]: {
          environments: [{ id: "env-prod", name: "production", canAccess: false }],
          services: [{ id: "svc-api", name: "api" }],
        },
      },
    });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("the token can't reach the restricted environment production");
  });

  test("a project token for another project fails the check and names it", async () => {
    const { destination } = setup({
      projects: {
        [OTHER]: { environments: [{ id: "env-x", name: "production" }], services: [] },
      },
      projectToken: { projectId: OTHER, environmentId: "env-x" },
    });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe(`the project token is for another project, ${OTHER}`);
    expect(check.destinationAccount).toBe(OTHER);
  });

  test("a project token for another environment fails the check", async () => {
    const { destination, railway } = setup({
      projectToken: { projectId: PROJECT, environmentId: "env-stage" },
    });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("the project token is for another environment, not production");
    expect(railway.effects).toEqual([]);
  });

  test.each([VALUE, 'line-one\nline-two "quoted" back\\slash', '{"client_secret":"s3cr3t"}'])(
    "a refused write names the HTTP status and never repeats Railway's message: %j",
    async (value) => {
      const { destination } = setup({ failWrites: true });
      await destination.checkAccount();
      const failed = await caught(destination.write("API_KEY", new Secret(value)));
      expect(failed.message).toContain("Railway variableUpsert returned HTTP 200");
      expect(failed.message).not.toContain("could not store");
      expectNoneOf([value, JSON.stringify(value).slice(1, -1), TOKEN], failed);
    },
  );

  test("a rate-limited check says to wait", async () => {
    const limited = new RailwayVariablesDestination({
      project: PROJECT,
      environment: "production",
      service: "api",
      token: async () => TOKEN,
      fetch: async () => new Response("{}", { status: 429 }),
    });
    const failed = await caught(limited.checkAccount());
    expect(failed.message).toContain("rate-limiting");
  });
});

describe("sign-in", () => {
  test("reads the token from KEYPIN_RAILWAY_TOKEN", async () => {
    expect(await railwaySignIn({ [TOKEN_VARIABLE]: ` ${TOKEN} ` }).token()).toBe(TOKEN);
  });

  test("without it, says how to make one, and that RAILWAY_TOKEN isn't used", async () => {
    const failed = await caught(
      railwaySignIn({ RAILWAY_TOKEN: TOKEN, RAILWAY_API_TOKEN: TOKEN }).token(),
    );
    assert(failed instanceof RailwaySignInFailed);
    expect(failed.message).toContain(`${TOKEN_VARIABLE}, which isn't set`);
    expect(failed.message).toContain(
      "RAILWAY_TOKEN and RAILWAY_API_TOKEN are set, but keypin doesn't sign in with them",
    );
    expectNoneOf([TOKEN], failed);
  });

  test("an empty token is refused", async () => {
    const failed = await caught(railwaySignIn({ [TOKEN_VARIABLE]: " " }).token());
    expect(failed.message).toContain("is set but empty");
  });

  const target = {
    to: "railway-service",
    account: PROJECT,
    environment: "production",
    service: "api",
  } as const;

  test("the account check stops without a token, before any request", async () => {
    const destination = railwayService.connect(target, { signInEnv: {} });
    const failed = await caught(destination.checkAccount());
    assert(failed instanceof RailwaySignInFailed);
    expect(failed.message).toContain(TOKEN_VARIABLE);
  });

  test("check lists the sign-in step only when a key publishes to Railway", async () => {
    const project = { folder: "/p", used: false };
    const missing = await railwayService.prerequisites?.(
      { ...project, targets: [target] },
      { env: {} },
    );
    expect(missing?.map((p) => p.status)).toEqual(["not logged in"]);
    const none = await railwayService.prerequisites?.({ ...project, targets: [] }, { env: {} });
    expect(none).toEqual([]);
    const set = { env: { [TOKEN_VARIABLE]: TOKEN } };
    expect(await railwayService.prerequisites?.({ ...project, targets: [target] }, set)).toEqual(
      [],
    );
  });
});

describe("keypin.toml", () => {
  const map = (table: string, key = "API_KEY") =>
    parseMap(
      `[1password]\naccount = "my.1password.com"\n\n[keys.${key}.prod]\nfrom = "op://Private/web/credential"\n\n[[keys.${key}.prod.publish]]\n${table}`,
      "keypin.toml",
      [railwayService],
      [],
      [onePasswordVault],
    );
  const errors = (parsed: ReturnType<typeof map>) => (parsed.ok ? "" : parsed.errors.join("\n"));
  const table = (project = PROJECT, environment = "production", service = "api") =>
    `to = "railway-service"\nproject = "${project}"\nenvironment = "${environment}"\nservice = "${service}"\n`;

  test("takes project, environment and service", () => {
    const parsed = map(table());
    expect(parsed.ok ? parsed.map.keys[0]?.environments.prod?.publish : parsed.errors).toEqual([
      { to: "railway-service", account: PROJECT, environment: "production", service: "api" },
    ]);
  });

  test("refuses a project that isn't an ID, and names with spaces", () => {
    expect(errors(map(table("my-app")))).toContain(`field "project" must be the project's ID`);
    expect(errors(map(table(PROJECT, "pr 12")))).toContain(`field "environment" must use only`);
  });

  test("refuses names Railway reserves", () => {
    expect(errors(map(table(), "RAILWAY_TOKEN"))).toContain(
      "Railway reserves names that start with RAILWAY_",
    );
  });

  test("ids round-trip, and each environment is its own destination", () => {
    const target = {
      to: "railway-service",
      account: PROJECT,
      environment: "staging",
      service: "api",
    } as const;
    expect(railwayService.fromId(railwayService.id(target), PROJECT)).toEqual(target);
    const production = { ...target, environment: "production" };
    expect(railwayService.secretId(target, "K")).not.toBe(railwayService.secretId(production, "K"));
  });
});
