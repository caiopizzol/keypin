import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, readSecretspec, Secret } from "@keypin/core";
import { expectNoneOf } from "@keypin/core/testing";
import {
  NetlifyEnvDestination,
  NetlifySignInFailed,
  netlifyProject,
  netlifySignIn,
  TOKEN_VARIABLE,
} from "../../src/netlify/index";
import { type FakeNetlify, type FakeVariable, netlifyFetch } from "../../src/netlify/testing";
import { onePasswordVault } from "../../src/onepassword/index";

const VALUE = "netlify-value-sentinel-5d1a";
const TOKEN = "netlify-token-sentinel-92ce";

async function caught(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(outcome instanceof Error, "expected a rejection");
  return outcome;
}

function setup(
  fake: Partial<FakeNetlify> = {},
  { context = "production", team = "acme", project = "web.netlify.app" } = {},
) {
  const state: FakeNetlify = {
    email: "alice@example.com",
    teams: { acme: { id: "acct_1", projects: { "web.netlify.app": "site-1" } } },
    ...fake,
  };
  const netlify = netlifyFetch(state);
  const requests: { method: string; url: string; body: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ method: init.method, url, body: init.body ?? "" });
    return netlify.fetch(url, init);
  };
  const destination = new NetlifyEnvDestination({
    team,
    project,
    context,
    token: async () => TOKEN,
    fetch,
  });
  return { state, netlify, requests, destination };
}

const variable = (over: Partial<FakeVariable>): FakeVariable => ({
  key: "API_KEY",
  is_secret: true,
  scopes: ["builds", "functions", "runtime"],
  values: [{ context: "production" }],
  ...over,
});

describe("writing", () => {
  test("creates a secret variable for the context, and says to redeploy", async () => {
    const { destination, netlify, requests } = setup();
    expect((await destination.checkAccount()).ok).toBe(true);
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(netlify.variables()).toEqual([
      {
        key: "API_KEY",
        is_secret: true,
        scopes: ["builds", "functions", "runtime"],
        values: [{ context: "production" }],
      },
    ]);
    expect(netlify.value("API_KEY", "production")).toBe(VALUE);
    expect(evidence).toMatchObject({ action: "created", type: "secret", context: "production" });
    expect(String(evidence.note)).toContain("next build and deploy");
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe("https://api.netlify.com/api/v1/accounts/acme/env?site_id=site-1");
    expect(requests.some((r) => r.url.includes("/builds") || r.url.includes("/deploys"))).toBe(
      false,
    );
    expectNoneOf([VALUE, TOKEN], evidence, netlify.effects);
  });

  test("sets only its context's value on a secret variable already there", async () => {
    const { destination, netlify, requests } = setup({
      variables: [variable({ values: [{ context: "production" }, { context: "deploy-preview" }] })],
    });
    await destination.checkAccount();
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(evidence).toMatchObject({ action: "updated" });
    expect(netlify.value("API_KEY", "production")).toBe(VALUE);
    expect(netlify.value("API_KEY", "deploy-preview")).toBeUndefined();
    const patch = requests.find((r) => r.method === "PATCH");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ context: "production", value: VALUE });
    expect(patch?.url).toContain("/env/API_KEY?site_id=site-1");
  });

  test("adds a value for a new context to a secret variable that has others", async () => {
    const { destination, netlify } = setup(
      { variables: [variable({})] },
      { context: "deploy-preview" },
    );
    await destination.checkAccount();
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(evidence).toMatchObject({ action: "created", context: "deploy-preview" });
    expect(netlify.variables()[0]?.values.map((v) => v.context)).toEqual([
      "production",
      "deploy-preview",
    ]);
  });

  test("another project's variables are separate", async () => {
    const { destination, netlify, state } = setup({
      teams: {
        acme: { id: "acct_1", projects: { "web.netlify.app": "site-1", "api.netlify.app": "s2" } },
      },
      otherProjects: { "api.netlify.app": [variable({})] },
    });
    await destination.checkAccount();
    expect((await destination.write("API_KEY", new Secret(VALUE))).action).toBe("created");
    expect(netlify.variables()).toHaveLength(1);
    expect(state.otherProjects?.["api.netlify.app"]).toHaveLength(1);
  });

  test("a project ID and the team's account ID work too", async () => {
    const { destination, requests } = setup({}, { team: "acct_1", project: "site-1" });
    expect((await destination.checkAccount()).ok).toBe(true);
    await destination.write("API_KEY", new Secret(VALUE));
    expect(requests.find((r) => r.method === "POST")?.url).toContain("/accounts/acme/env");
  });
});

describe("refusals", () => {
  test("a variable not marked secret isn't written", async () => {
    const { destination, netlify } = setup({ variables: [variable({ is_secret: false })] });
    await destination.checkAccount();
    const refused = await caught(destination.write("API_KEY", new Secret(VALUE)));
    expect(refused.message).toContain("isn't marked as containing secret values");
    expect(refused.message).toContain("Contains secret values");
    expect(netlify.effects).toEqual([]);
  });

  test("a project in another team fails the check and names its team", async () => {
    const { destination } = setup({}, { team: "other" });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("the project web.netlify.app belongs to team acme, not other");
    expect(check.destinationAccount).toBe("acme");
  });

  test("a project the token can't reach fails the check", async () => {
    const { destination } = setup({ teams: {} });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("the token can't reach the project web.netlify.app");
    expect(check.fix).toContain("SAML");
  });

  test("a refused token fails the check with how to make one", async () => {
    const { destination } = setup({ invalidToken: true });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("Netlify refused the token");
    expect(check.fix).toContain(TOKEN_VARIABLE);
    expect(check.publisher).toContain("unknown");
  });

  test.each([VALUE, 'line-one\nline-two "quoted" back\\slash', '{"client_secret":"s3cr3t"}'])(
    "a refused write names the HTTP status and never repeats Netlify's message: %j",
    async (value) => {
      const { destination } = setup({ failWrites: true });
      await destination.checkAccount();
      const failed = await caught(destination.write("API_KEY", new Secret(value)));
      expect(failed.message).toContain("returned HTTP 400");
      expect(failed.message).not.toContain("could not store");
      expectNoneOf([value, JSON.stringify(value).slice(1, -1), TOKEN], failed);
    },
  );

  test("a context keypin doesn't write is refused when constructing", () => {
    expect(
      () =>
        new NetlifyEnvDestination({
          team: "acme",
          project: "web.netlify.app",
          context: "dev",
          token: async () => TOKEN,
        }),
    ).toThrow("isn't a Netlify deploy context keypin writes");
  });
});

describe("sign-in", () => {
  test("reads the token from KEYPIN_NETLIFY_TOKEN", async () => {
    expect(await netlifySignIn({ [TOKEN_VARIABLE]: ` ${TOKEN} ` }).token()).toBe(TOKEN);
  });

  test("without it, says how to make one, and that NETLIFY_AUTH_TOKEN isn't used", async () => {
    const failed = await caught(netlifySignIn({ NETLIFY_AUTH_TOKEN: TOKEN }).token());
    assert(failed instanceof NetlifySignInFailed);
    expect(failed.message).toContain(`${TOKEN_VARIABLE}, which isn't set`);
    expect(failed.message).toContain(
      "NETLIFY_AUTH_TOKEN is set, but keypin doesn't sign in with it",
    );
    expectNoneOf([TOKEN], failed);
  });

  test("an empty token is refused", async () => {
    const failed = await caught(netlifySignIn({ [TOKEN_VARIABLE]: " " }).token());
    expect(failed.message).toContain("is set but empty");
  });

  const target = {
    to: "netlify-project",
    account: "acme",
    project: "web.netlify.app",
    context: "production",
  } as const;

  test("the account check stops without a token, before any request", async () => {
    const destination = netlifyProject.connect(target, { signInEnv: {} });
    const failed = await caught(destination.checkAccount());
    assert(failed instanceof NetlifySignInFailed);
    expect(failed.message).toContain(TOKEN_VARIABLE);
  });

  test("check lists the sign-in step only when a key publishes to Netlify", async () => {
    const project = { folder: "/p", used: false };
    const missing = await netlifyProject.prerequisites?.(
      { ...project, targets: [target] },
      { env: {} },
    );
    expect(missing?.map((p) => p.status)).toEqual(["not logged in"]);
    const none = await netlifyProject.prerequisites?.({ ...project, targets: [] }, { env: {} });
    expect(none).toEqual([]);
    const set = { env: { [TOKEN_VARIABLE]: TOKEN } };
    expect(await netlifyProject.prerequisites?.({ ...project, targets: [target] }, set)).toEqual(
      [],
    );
  });
});

describe("secretspec.toml", () => {
  const map = (table: string, key = "API_KEY") =>
    readSecretspec(
      `[project]\nname = "web"\nrevision = "1.0"\n\n[profiles.prod]\n${key} = { description = "a key", providers = ["onepassword://my.1password.com@Private"], ref = { item = "web", field = "credential" } }\n\n[[tool.keypin.prod.${key}.publish]]\n${table}`,
      "secretspec.toml",
      [netlifyProject],
      [],
      [onePasswordVault],
    );
  const errors = (parsed: ReturnType<typeof map>) => (parsed.ok ? "" : parsed.errors.join("\n"));
  const table = (context = "production", project = "web.netlify.app") =>
    `to = "netlify-project"\nteam = "acme"\nproject = "${project}"\ncontext = "${context}"\n`;

  test("takes team, project and context", () => {
    const parsed = map(table());
    expect(parsed.ok ? parsed.map.keys[0]?.environments.prod?.publish : parsed.errors).toEqual([
      { to: "netlify-project", account: "acme", project: "web.netlify.app", context: "production" },
    ]);
  });

  test("takes each deploy context Netlify keeps secret, and a project ID", () => {
    for (const context of ["production", "deploy-preview", "branch-deploy", "dev-server"])
      expect(map(table(context)).ok).toBe(true);
    expect(map(table("production", "1d01c0c0-4554-4747-93b8-34ce3448ab95")).ok).toBe(true);
  });

  test("refuses the dev context, and points to keypin run", () => {
    expect(errors(map(table("dev")))).toContain(`can't be "dev"`);
    expect(errors(map(table("dev")))).toContain("keypin run -- netlify dev");
    expect(errors(map(table("all")))).toContain(`field "context" must be one of production`);
  });

  test("refuses a project name that isn't an ID or a domain", () => {
    expect(errors(map(table("production", "web")))).toContain("such as web.netlify.app");
  });

  test("refuses a name Netlify reserves, or one that doesn't start with a letter", () => {
    expect(errors(map(table(), "URL"))).toContain("Netlify reserves the name URL");
    expect(errors(map(table(), "_TOKEN"))).toContain("Netlify names must start with a letter");
  });

  test("ids round-trip, and each context is its own destination", () => {
    const target = {
      to: "netlify-project",
      account: "acme",
      project: "web.netlify.app",
      context: "deploy-preview",
    } as const;
    expect(netlifyProject.fromId(netlifyProject.id(target), "acme")).toEqual(target);
    const production = { ...target, context: "production" };
    expect(netlifyProject.secretId(target, "K")).not.toBe(netlifyProject.secretId(production, "K"));
  });
});
