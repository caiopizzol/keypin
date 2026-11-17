import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, parseMap, Secret } from "@keypin/core";
import { expectNoneOf } from "@keypin/core/testing";
import { onePasswordVault } from "../../src/onepassword/index";
import {
  TOKEN_VARIABLE,
  VercelEnvDestination,
  VercelSignInFailed,
  vercelProject,
  vercelSignIn,
} from "../../src/vercel/index";
import { type FakeVariable, type FakeVercel, vercelFetch } from "../../src/vercel/testing";

const VALUE = "vercel-value-sentinel-3b9e";
const TOKEN = "vercel-token-sentinel-71c4";

async function caught(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(outcome instanceof Error, "expected a rejection");
  return outcome;
}

function setup(fake: Partial<FakeVercel> = {}, environment = "production", team = "team_acme") {
  const state: FakeVercel = {
    username: "alice",
    teams: { team_acme: { slug: "acme", projects: { web: ["staging"] } } },
    ...fake,
  };
  const vercel = vercelFetch(state);
  const requests: { method: string; url: string; body: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ method: init.method, url, body: init.body ?? "" });
    return vercel.fetch(url, init);
  };
  const destination = new VercelEnvDestination({
    team,
    project: "web",
    environment,
    token: async () => TOKEN,
    fetch,
  });
  return { state, vercel, requests, destination };
}

const variable = (over: Partial<FakeVariable>): FakeVariable => ({
  id: "env-old",
  key: "API_KEY",
  type: "sensitive",
  target: ["production"],
  customEnvironmentIds: [],
  ...over,
});

describe("writing", () => {
  test("creates a sensitive variable for the environment, and says to redeploy", async () => {
    const { destination, vercel, requests } = setup();
    expect((await destination.checkAccount()).ok).toBe(true);
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    const [created] = vercel.variables();
    expect(created).toMatchObject({ key: "API_KEY", type: "sensitive", target: ["production"] });
    expect(vercel.value("API_KEY", "production")).toBe(VALUE);
    expect(evidence).toMatchObject({ action: "created", type: "sensitive" });
    expect(String(evidence.note)).toContain("new deployments");
    const post = requests.find((r) => r.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ visibility: "secret" });
    expect(post?.url).toContain("teamId=team_acme");
    expect(requests.some((r) => r.url.includes("/deployments"))).toBe(false);
    expectNoneOf([VALUE, TOKEN], evidence, vercel.effects);
  });

  test("updates the variable already there for that environment", async () => {
    const { destination, vercel, requests } = setup({
      variables: [variable({ type: "encrypted" })],
    });
    await destination.checkAccount();
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(vercel.variables()).toHaveLength(1);
    expect(vercel.variables()[0]?.type).toBe("sensitive");
    expect(vercel.value("API_KEY", "production")).toBe(VALUE);
    expect(evidence).toMatchObject({ action: "updated", variableId: "env-old" });
    expect(requests.map((r) => r.method)).toContain("PATCH");
  });

  test("leaves the same name in other environments and preview branches alone", async () => {
    const others = [
      variable({ id: "env-preview", target: ["preview"] }),
      variable({ id: "env-branch", target: ["production"], gitBranch: "feature" }),
    ];
    const { destination, vercel } = setup({ variables: others });
    await destination.checkAccount();
    expect((await destination.write("API_KEY", new Secret(VALUE))).action).toBe("created");
    expect(vercel.variables()).toHaveLength(3);
  });

  test("writes a custom environment by its ID", async () => {
    const { destination, vercel } = setup({}, "staging");
    expect((await destination.checkAccount()).ok).toBe(true);
    await destination.write("API_KEY", new Secret(VALUE));
    expect(vercel.variables()[0]).toMatchObject({
      target: [],
      customEnvironmentIds: ["env_staging"],
    });
  });

  test("a team slug scopes requests with slug", async () => {
    const { destination, requests } = setup({}, "production", "acme");
    expect((await destination.checkAccount()).ok).toBe(true);
    expect(requests.find((r) => r.url.includes("/projects/"))?.url).toContain("slug=acme");
  });
});

describe("refusals", () => {
  test("a variable shared with other environments isn't overwritten", async () => {
    const shared = variable({ target: ["production", "preview"], customEnvironmentIds: ["env_x"] });
    const { destination, vercel } = setup({ variables: [shared] });
    await destination.checkAccount();
    const refused = await caught(destination.write("API_KEY", new Secret(VALUE)));
    expect(refused.message).toContain("production and preview, env_x");
    expect(vercel.effects).toEqual([]);
  });

  test("two variables for the environment stop the write", async () => {
    const twice = [variable({}), variable({ id: "env-2" })];
    const { destination, vercel } = setup({ variables: twice });
    await destination.checkAccount();
    expect((await caught(destination.write("API_KEY", new Secret(VALUE)))).message).toContain(
      "2 variables named API_KEY",
    );
    expect(vercel.effects).toEqual([]);
  });

  test("a system variable isn't written", async () => {
    const { destination } = setup({ variables: [variable({ type: "system" })] });
    await destination.checkAccount();
    expect((await caught(destination.write("API_KEY", new Secret(VALUE)))).message).toContain(
      "system environment variable",
    );
  });

  test("a project the token can't reach fails the check", async () => {
    const { destination } = setup({ teams: {} });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toContain("can't reach the project web in team team_acme");
  });

  test("a refused token fails the check with how to make one", async () => {
    const { destination } = setup({ invalidToken: true });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("Vercel refused the token");
    expect(check.fix).toContain(TOKEN_VARIABLE);
    expect(check.publisher).toContain("unknown");
  });

  test("a custom environment the project lacks fails the check", async () => {
    const { destination } = setup({}, "qa");
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toContain("has no environment qa");
  });

  test("a refused write names the HTTP status and hides the value and token", async () => {
    const { destination } = setup({ failWrites: true });
    await destination.checkAccount();
    const failed = await caught(destination.write("API_KEY", new Secret(VALUE)));
    expect(failed.message).toContain("returned HTTP 400");
    expectNoneOf([VALUE, TOKEN], failed);
  });

  test("names keypin can't use are refused when constructing", () => {
    expect(
      () =>
        new VercelEnvDestination({
          team: "team acme",
          project: "web",
          environment: "production",
          token: async () => TOKEN,
        }),
    ).toThrow("isn't a Vercel team");
  });
});

describe("sign-in", () => {
  test("reads the token from KEYPIN_VERCEL_TOKEN", async () => {
    expect(await vercelSignIn({ [TOKEN_VARIABLE]: ` ${TOKEN} ` }).token()).toBe(TOKEN);
  });

  test("without it, says how to make one, and that VERCEL_TOKEN isn't used", async () => {
    const failed = await caught(vercelSignIn({ VERCEL_TOKEN: TOKEN }).token());
    assert(failed instanceof VercelSignInFailed);
    expect(failed.message).toContain(`${TOKEN_VARIABLE}, which isn't set`);
    expect(failed.message).toContain("VERCEL_TOKEN is set, but keypin doesn't sign in with it");
    expectNoneOf([TOKEN], failed);
  });

  test("the account check stops without a token, before any request", async () => {
    const target = {
      to: "vercel-project",
      account: "acme",
      project: "web",
      environment: "production",
    } as const;
    const destination = vercelProject.connect(target, { signInEnv: {} });
    const failed = await caught(destination.checkAccount());
    assert(failed instanceof VercelSignInFailed);
    expect(failed.message).toContain(TOKEN_VARIABLE);
  });

  test("an empty token is refused", async () => {
    const failed = await caught(vercelSignIn({ [TOKEN_VARIABLE]: " " }).token());
    expect(failed.message).toContain("is set but empty");
  });

  test("check lists the sign-in step only when a key publishes to Vercel", async () => {
    const target = {
      to: "vercel-project",
      account: "acme",
      project: "web",
      environment: "production",
    } as const;
    const project = { folder: "/p", used: false };
    const missing = await vercelProject.prerequisites?.(
      { ...project, targets: [target] },
      { env: {} },
    );
    expect(missing?.map((p) => p.status)).toEqual(["not logged in"]);
    const none = await vercelProject.prerequisites?.({ ...project, targets: [] }, { env: {} });
    expect(none).toEqual([]);
    const set = { env: { [TOKEN_VARIABLE]: TOKEN } };
    expect(await vercelProject.prerequisites?.({ ...project, targets: [target] }, set)).toEqual([]);
  });
});

describe("keypin.toml", () => {
  const map = (table: string) =>
    parseMap(
      `[1password]\naccount = "my.1password.com"\n\n[keys.API_KEY.prod]\nfrom = "op://Private/web/credential"\n\n[[keys.API_KEY.prod.publish]]\n${table}`,
      "keypin.toml",
      [vercelProject],
      [],
      [onePasswordVault],
    );

  test("takes team, project and environment", () => {
    const parsed = map(
      `to = "vercel-project"\nteam = "team_acme"\nproject = "web"\nenvironment = "production"\n`,
    );
    expect(parsed.ok ? parsed.map.keys[0]?.environments.prod?.publish : parsed.errors).toEqual([
      { to: "vercel-project", account: "team_acme", project: "web", environment: "production" },
    ]);
  });

  test("needs each field, and refuses a name Vercel reserves", () => {
    const missing = map(`to = "vercel-project"\nteam = "team_acme"\nproject = "web"\n`);
    expect(missing.ok ? [] : missing.errors.join("\n")).toContain(`missing field "environment"`);
    const reserved = parseMap(
      `[1password]\naccount = "a.1password.com"\n\n[keys.TZ.prod]\nfrom = "op://P/i/f"\n\n[[keys.TZ.prod.publish]]\nto = "vercel-project"\nteam = "acme"\nproject = "web"\nenvironment = "production"\n`,
      "keypin.toml",
      [vercelProject],
      [],
      [onePasswordVault],
    );
    expect(reserved.ok ? [] : reserved.errors.join("\n")).toContain("Vercel reserves the name TZ");
  });

  test("ids round-trip, and each environment is its own destination", () => {
    const target = {
      to: "vercel-project",
      account: "acme",
      project: "web",
      environment: "preview",
    } as const;
    expect(vercelProject.fromId(vercelProject.id(target), "acme")).toEqual(target);
    const production = { ...target, environment: "production" };
    expect(vercelProject.secretId(target, "K")).not.toBe(vercelProject.secretId(production, "K"));
  });
});
