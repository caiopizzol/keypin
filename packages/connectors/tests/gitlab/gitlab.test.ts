import { assert, describe, expect, test } from "vite-plus/test";
import { parseMap, parseObject, Secret } from "@keypin/core";
import { expectNoneOf } from "@keypin/core/testing";
import { onePasswordVault } from "../../src/onepassword/index";
import {
  GitLabSignInFailed,
  gitlabGroup,
  gitlabProject,
  gitlabSignIn,
  GitLabVariablesDestination,
  TOKEN_VARIABLE,
} from "../../src/gitlab/index";
import { type FakeGitLab, type FakeGitLabVariable, gitlabFetch } from "../../src/gitlab/testing";
import type { Glab } from "../../src/gitlab/token";

const VALUE = "gitlab-value-sentinel-5c1d";
const TOKEN = "glpat-gitlab-token-sentinel-93fa";

async function caught(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(outcome instanceof Error, "expected a rejection");
  return outcome;
}

type Setup = {
  owner?: "project" | "group";
  path?: string;
  scope?: string;
  host?: string;
  token?: string;
  via?: "token" | "glab";
};

function setup(fake: Partial<FakeGitLab> = {}, options: Setup = {}) {
  const state: FakeGitLab = {
    tokens: {
      [TOKEN]: {
        user: "alice",
        scopes: ["api"],
        reaches: { "acme/billing": "admin", acme: "admin" },
      },
    },
    ...fake,
  };
  const gitlab = gitlabFetch(state);
  const destination = new GitLabVariablesDestination({
    owner: options.owner ?? "project",
    host: options.host ?? "gitlab.com",
    path: options.path ?? "acme/billing",
    environmentScope: options.scope ?? "*",
    via: options.via ?? "token",
    token: async () => options.token ?? TOKEN,
    fetch: gitlab.fetch,
  });
  return { state, gitlab, destination };
}

const variable = (over: Partial<FakeGitLabVariable> = {}): FakeGitLabVariable => ({
  key: "API_KEY",
  environmentScope: "*",
  masked: false,
  hidden: false,
  protected: false,
  raw: true,
  ...over,
});

const writes = (gitlab: ReturnType<typeof gitlabFetch>) =>
  gitlab.requests.filter((r) => r.path.startsWith("/api/v4/") && r.method !== "GET");
const sentBody = (gitlab: ReturnType<typeof gitlabFetch>, method: string) =>
  parseObject(writes(gitlab).find((r) => r.method === method)?.body ?? "{}");

describe("writing", () => {
  test("creates a masked, hidden variable and says the next pipeline uses it", async () => {
    const { destination, gitlab } = setup();
    expect((await destination.checkAccount()).ok).toBe(true);
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(gitlab.variables("acme/billing")).toEqual([variable({ masked: true, hidden: true })]);
    expect(gitlab.value("acme/billing", "API_KEY")).toBe(VALUE);
    expect(sentBody(gitlab, "POST")).toMatchObject({
      masked: true,
      masked_and_hidden: true,
      raw: true,
      environment_scope: "*",
    });
    expect(evidence).toMatchObject({ action: "created", masked: true, hidden: true });
    expect(String(evidence.note)).toContain("next pipeline");
    expectNoneOf([VALUE, TOKEN], evidence, gitlab.effects, destination.describe());
  });

  test("updates an existing variable in place, masks it and keeps it protected", async () => {
    const { destination, gitlab } = setup({
      variables: { "acme/billing": [variable({ protected: true })] },
    });
    await destination.checkAccount();
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(gitlab.variables("acme/billing")).toEqual([variable({ protected: true, masked: true })]);
    const put = sentBody(gitlab, "PUT");
    expect(put).toEqual({ value: VALUE, masked: true });
    expect(writes(gitlab)[0]?.path).toContain("filter%5Benvironment_scope%5D=*");
    expect(evidence).toMatchObject({ action: "updated", hidden: false, protected: true });
  });

  test("never asks the REST API for a variable, so no value is read back", async () => {
    const { destination, gitlab } = setup({
      variables: { "acme/billing": [variable()] },
    });
    await destination.checkAccount();
    await destination.write("API_KEY", new Secret(VALUE));
    const reads = gitlab.requests.filter(
      (r) => r.method === "GET" && r.path.includes("/variables"),
    );
    expect(reads).toEqual([]);
    const queries = gitlab.requests.filter((r) => r.path === "/api/graphql").map((r) => r.body);
    expect(queries.some((q) => /\bvalue\b/.test(String(parseObject(q).query)))).toBe(false);
  });

  test("writes the environment scope the map names, separately from *", async () => {
    const { destination, gitlab } = setup(
      { variables: { "acme/billing": [variable()] } },
      { scope: "production" },
    );
    await destination.checkAccount();
    expect((await destination.write("API_KEY", new Secret(VALUE))).action).toBe("created");
    expect(gitlab.variables("acme/billing").map((v) => v.environmentScope)).toEqual([
      "*",
      "production",
    ]);
    expect(gitlab.value("acme/billing", "API_KEY", "production")).toBe(VALUE);
  });

  test("finds the variable on a later page instead of creating a duplicate", async () => {
    const filler = Array.from({ length: 5 }, (_, i) => variable({ key: `OTHER_${i}` }));
    const { destination, gitlab } = setup({
      variables: { "acme/billing": [...filler, variable()] },
      pageSize: 2,
    });
    await destination.checkAccount();
    expect((await destination.write("API_KEY", new Secret(VALUE))).action).toBe("updated");
    expect(gitlab.variables("acme/billing")).toHaveLength(6);
  });

  test("writes a group variable without an environment scope", async () => {
    const { destination, gitlab } = setup({}, { owner: "group", path: "acme" });
    expect((await destination.checkAccount()).ok).toBe(true);
    await destination.write("API_KEY", new Secret(VALUE));
    expect(writes(gitlab)[0]?.path).toBe("/api/v4/groups/acme/variables");
    expect(sentBody(gitlab, "POST")).not.toHaveProperty("environment_scope");
    expect(gitlab.value("acme", "API_KEY")).toBe(VALUE);
  });

  test("a self-managed host gets the requests", async () => {
    const { destination, gitlab } = setup({ host: "gitlab.acme.dev" }, { host: "gitlab.acme.dev" });
    expect((await destination.checkAccount()).ok).toBe(true);
    await destination.write("API_KEY", new Secret(VALUE));
    expect(gitlab.effects).toEqual(["gitlab create projects acme/billing API_KEY"]);
  });

  test("a project or group access token, which has no personal token to inspect, still works", async () => {
    const { destination } = setup({
      tokens: {
        [TOKEN]: {
          user: "project_1_bot",
          scopes: ["api"],
          reaches: { "acme/billing": "admin" },
          personal: false,
        },
      },
    });
    const check = await destination.checkAccount();
    expect(check).toMatchObject({ ok: true, publisher: "project_1_bot" });
  });
});

describe("refusals", () => {
  test("a value GitLab can't mask isn't written", async () => {
    for (const value of ["short", "has a space", "two\nlines!"]) {
      const { destination, gitlab } = setup();
      await destination.checkAccount();
      const refused = await caught(destination.write("API_KEY", new Secret(value)));
      expect(refused.message).toContain("8 or more characters");
      expect(gitlab.effects).toEqual([]);
      expectNoneOf([value], refused);
    }
  });

  test("an existing variable that expands references refuses characters it can't mask", async () => {
    const { destination, gitlab } = setup({
      variables: { "acme/billing": [variable({ raw: false })] },
    });
    await destination.checkAccount();
    const refused = await caught(destination.write("API_KEY", new Secret(`${VALUE}$!`)));
    expect(refused.message).toContain("Expand variable reference");
    expect(gitlab.effects).toEqual([]);
  });

  test("a token without the api scope fails the check", async () => {
    const { destination } = setup({
      tokens: {
        [TOKEN]: { user: "alice", scopes: ["read_api"], reaches: { "acme/billing": "admin" } },
      },
    });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toContain("api scope; it has read_api");
    expect(check.fix).toContain(TOKEN_VARIABLE);
  });

  test("a developer on the project fails the check: Maintainer is needed", async () => {
    const { destination } = setup({
      tokens: {
        [TOKEN]: { user: "alice", scopes: ["api"], reaches: { "acme/billing": "member" } },
      },
    });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toContain("needs the Maintainer role");
  });

  test("a Maintainer on a group fails the check: Owner is needed", async () => {
    const { destination } = setup(
      { tokens: { [TOKEN]: { user: "alice", scopes: ["api"], reaches: { acme: "member" } } } },
      { owner: "group", path: "acme" },
    );
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toContain("needs the Owner role");
  });

  test("a CI/CD job token is refused before any request", async () => {
    const { destination, gitlab } = setup({}, { token: "glcbt-64_job-token" });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toContain("job token can't change CI/CD variables");
    expect(gitlab.requests).toEqual([]);
  });

  test("a project the login can't reach fails the check", async () => {
    const { destination } = setup({}, { path: "acme/other" });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toContain("can't reach the project acme/other on gitlab.com");
  });

  test("a refused token and a refused glab login each say what to do", async () => {
    const token = await setup({ tokens: {} }).destination.checkAccount();
    assert(!token.ok);
    expect(token.reason).toContain(`token in ${TOKEN_VARIABLE}`);
    const glab = await setup({ tokens: {} }, { via: "glab" }).destination.checkAccount();
    assert(!glab.ok);
    expect(glab.reason).toContain("glab auth login --hostname gitlab.com");
  });

  test("a refused write names the HTTP status and hides the value and token", async () => {
    const { destination } = setup({ failWrites: true });
    await destination.checkAccount();
    const failed = await caught(destination.write("API_KEY", new Secret(VALUE)));
    expect(failed.message).toContain("returned HTTP 400");
    expectNoneOf([VALUE, TOKEN], failed);
  });

  test("a host or path keypin can't use is refused when constructing", () => {
    const make = (host: string, path: string) =>
      new GitLabVariablesDestination({
        owner: "project",
        host,
        path,
        environmentScope: "*",
        via: "token",
        token: async () => TOKEN,
      });
    expect(() => make("https://gitlab.com", "acme/billing")).toThrow("isn't a GitLab host");
    expect(() => make("gitlab.com", "acme/../billing")).toThrow("isn't a GitLab project");
    expect(() => make("gitlab.com", "acme//billing")).toThrow("isn't a GitLab project");
  });
});

describe("sign-in", () => {
  const glabSays =
    (stdout: string, missing = false, seen: Record<string, string>[] = []): Glab =>
    async (_args, env) => {
      seen.push(env);
      return { ok: !missing && stdout !== "", stdout, missing };
    };

  test("KEYPIN_GITLAB_TOKEN wins over glab", async () => {
    const login = gitlabSignIn({
      env: { [TOKEN_VARIABLE]: ` ${TOKEN} ` },
      signIn: [],
      host: "gitlab.com",
      glab: glabSays("glpat-from-glab"),
    });
    expect(login.via).toBe("token");
    expect(await login.token()).toBe(TOKEN);
  });

  test("otherwise reads the glab login for the host, without GITLAB_TOKEN in its environment", async () => {
    const seen: Record<string, string>[] = [];
    const login = gitlabSignIn({
      env: { GITLAB_TOKEN: "glpat-ambient", PATH: "/bin" },
      signIn: [],
      host: "gitlab.acme.dev",
      glab: glabSays(`${TOKEN}\n`, false, seen),
    });
    expect(login.via).toBe("glab");
    expect(await login.token()).toBe(TOKEN);
    expect(seen[0]).toEqual({ PATH: "/bin" });
  });

  test("without glab or a token, says how to sign in, and that GITLAB_TOKEN isn't used", async () => {
    const failed = await caught(
      gitlabSignIn({
        env: { GITLAB_TOKEN: TOKEN },
        signIn: [],
        host: "gitlab.com",
        glab: glabSays("", true),
      }).token(),
    );
    assert(failed instanceof GitLabSignInFailed);
    expect(failed.message).toContain("keypin can't find glab");
    expect(failed.message).toContain("GITLAB_TOKEN is set, but keypin doesn't sign in with it");
    expectNoneOf([TOKEN], failed);
  });

  test("glab without a login for the host says to run glab auth login", async () => {
    const failed = await caught(
      gitlabSignIn({ env: {}, signIn: [], host: "gitlab.acme.dev", glab: glabSays("") }).token(),
    );
    expect(failed.message).toContain("glab has no token for gitlab.acme.dev");
    expect(failed.message).toContain("glab auth login --hostname gitlab.acme.dev");
  });

  test("an empty token is refused", async () => {
    const login = gitlabSignIn({ env: { [TOKEN_VARIABLE]: " " }, signIn: [], host: "gitlab.com" });
    expect((await caught(login.token())).message).toContain("is set but empty");
  });

  test("check lists the sign-in step only without a token and without glab", async () => {
    const target = { to: "gitlab-project", account: "acme", project: "acme/billing" } as const;
    const project = { folder: "/p", used: false };
    const missing = await gitlabProject.prerequisites?.(
      { ...project, targets: [target] },
      { env: { PATH: "/no-such-dir" } },
    );
    expect(missing?.map((p) => p.title)).toEqual(["Sign in to GitLab"]);
    const none = await gitlabProject.prerequisites?.({ ...project, targets: [] }, { env: {} });
    expect(none).toEqual([]);
    const set = { env: { [TOKEN_VARIABLE]: TOKEN } };
    expect(await gitlabProject.prerequisites?.({ ...project, targets: [target] }, set)).toEqual([]);
  });
});

describe("keypin.toml", () => {
  const map = (table: string, name = "API_KEY") =>
    parseMap(
      `[1password]\naccount = "my.1password.com"\n\n[keys.${name}.prod]\nfrom = "op://Private/web/credential"\n\n[[keys.${name}.prod.publish]]\n${table}`,
      "keypin.toml",
      [gitlabProject, gitlabGroup],
      [],
      [onePasswordVault],
    );
  const publish = (parsed: ReturnType<typeof map>) =>
    parsed.ok ? parsed.map.keys[0]?.environments.prod?.publish : parsed.errors;

  test("a project takes its path, and optionally host and environment_scope", () => {
    expect(publish(map(`to = "gitlab-project"\nproject = "acme/billing"\n`))).toEqual([
      { to: "gitlab-project", account: "acme", project: "acme/billing" },
    ]);
    expect(
      publish(
        map(
          `to = "gitlab-project"\nproject = "acme/sub/billing"\nhost = "gitlab.acme.dev"\nenvironment_scope = "production"\n`,
        ),
      ),
    ).toEqual([
      {
        to: "gitlab-project",
        account: "acme",
        project: "acme/sub/billing",
        host: "gitlab.acme.dev",
        environment_scope: "production",
      },
    ]);
  });

  test("gitlab.com and * are the defaults, so they aren't stored", () => {
    expect(
      publish(
        map(
          `to = "gitlab-project"\nproject = "acme/billing"\nhost = "gitlab.com"\nenvironment_scope = "*"\n`,
        ),
      ),
    ).toEqual([{ to: "gitlab-project", account: "acme", project: "acme/billing" }]);
  });

  test("a group takes its path and host, not environment_scope", () => {
    expect(publish(map(`to = "gitlab-group"\ngroup = "acme/platform"\n`))).toEqual([
      { to: "gitlab-group", account: "acme", group: "acme/platform" },
    ]);
    const scoped = map(`to = "gitlab-group"\ngroup = "acme"\nenvironment_scope = "production"\n`);
    expect(scoped.ok ? "" : scoped.errors.join("\n")).toContain("environment_scope");
  });

  test("refuses a URL as host", () => {
    const bad = map(
      `to = "gitlab-project"\nproject = "acme/billing"\nhost = "https://gitlab.acme.dev"\n`,
    );
    expect(bad.ok ? "" : bad.errors.join("\n")).toContain("without https://");
  });

  test("ids round-trip, and each environment scope is its own destination", () => {
    const target = {
      to: "gitlab-project",
      account: "acme",
      project: "acme/billing",
      host: "gitlab.acme.dev",
      environment_scope: "review/*",
    } as const;
    expect(gitlabProject.fromId(gitlabProject.id(target), "acme")).toEqual(target);
    const all = { to: "gitlab-project", account: "acme", project: "acme/billing" } as const;
    expect(gitlabProject.fromId(gitlabProject.id(all), "acme")).toEqual(all);
    expect(gitlabProject.secretId(target, "K")).not.toBe(
      gitlabProject.secretId({ ...target, environment_scope: "production" }, "K"),
    );
    const group = { to: "gitlab-group", account: "acme", group: "acme" } as const;
    expect(gitlabGroup.fromId(gitlabGroup.id(group), "acme")).toEqual(group);
  });
});
