import { assert, describe, expect, test } from "vite-plus/test";
import { type Fetch, parseMap, Secret } from "@keypin/core";
import { expectNoneOf } from "@keypin/core/testing";
import { onePasswordVault } from "../../src/onepassword/index";
import {
  SupabaseSecretsDestination,
  SupabaseSignInFailed,
  supabaseFunctions,
  supabaseSignIn,
  TOKEN_VARIABLE,
} from "../../src/supabase/index";
import { type FakeSecrets, secretsFetch } from "../../src/supabase/testing";

const REF = "abcdefghijklmnopqrst";
const VALUE = "supabase-value-sentinel-5d1a";
const TOKEN = "sbp_token_sentinel_9e2b";

async function caught(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(outcome instanceof Error, "expected a rejection");
  return outcome;
}

function setup(fake: Partial<FakeSecrets> = {}) {
  const state: FakeSecrets = { token: TOKEN, username: "alice", projects: { [REF]: {} }, ...fake };
  const supabase = secretsFetch(state);
  const requests: { method: string; url: string; body: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ method: init.method, url, body: init.body ?? "" });
    return supabase.fetch(url, init);
  };
  const destination = new SupabaseSecretsDestination({
    projectRef: REF,
    token: async () => TOKEN,
    fetch,
  });
  return { state, supabase, requests, destination };
}

describe("writing", () => {
  test("creates the secret, and says functions read it with no redeploy", async () => {
    const { destination, state, supabase, requests } = setup();
    const check = await destination.checkAccount();
    expect(check).toMatchObject({ ok: true, publisher: "alice", destinationAccount: REF });
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(state.projects[REF]).toEqual({ API_KEY: VALUE });
    expect(evidence).toMatchObject({ action: "created", secret: "API_KEY" });
    expect(String(evidence.note)).toContain("no redeploy");
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe(`https://api.supabase.com/v1/projects/${REF}/secrets`);
    expect(JSON.parse(post?.body ?? "")).toEqual([{ name: "API_KEY", value: VALUE }]);
    expect(requests.some((r) => r.url.includes("/functions"))).toBe(false);
    expectNoneOf([VALUE, TOKEN], evidence, supabase.effects, check);
  });

  test("replaces a secret already there", async () => {
    const { destination, state, supabase } = setup({ projects: { [REF]: { API_KEY: "old" } } });
    await destination.checkAccount();
    const evidence = await destination.write("API_KEY", new Secret(VALUE));
    expect(state.projects[REF]?.API_KEY).toBe(VALUE);
    expect(evidence.action).toBe("updated");
    expect(supabase.effects).toEqual([`supabase secret update ${REF} API_KEY`]);
  });

  test("a token that can't read its profile still publishes", async () => {
    const { destination } = setup({ username: null });
    const check = await destination.checkAccount();
    expect(check).toMatchObject({
      ok: true,
      publisher: "unknown (the token can't read its profile)",
    });
  });
});

describe("refusals", () => {
  test("a name that starts with SUPABASE_ is refused before any request", async () => {
    const { destination, requests } = setup();
    await destination.checkAccount();
    const before = requests.length;
    const refused = await caught(destination.write("SUPABASE_URL", new Secret(VALUE)));
    expect(refused.message).toContain("Supabase reserves names that start with SUPABASE_");
    expect(requests.length).toBe(before);
  });

  test("names and values longer than Supabase takes are refused before any request", async () => {
    const { destination, requests } = setup();
    await destination.checkAccount();
    const before = requests.length;
    const long = await caught(destination.write("K".repeat(257), new Secret(VALUE)));
    expect(long.message).toContain("up to 256 characters");
    const big = await caught(destination.write("API_KEY", new Secret("v".repeat(24577))));
    expect(big.message).toContain("up to 24576 characters");
    expect(requests.length).toBe(before);
  });

  test("a refused token fails the check with how to make one", async () => {
    const { destination } = setup({ token: "sbp_other" });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toBe("Supabase refused the token");
    expect(check.fix).toContain(TOKEN_VARIABLE);
    expect(check.publisher).toContain("unknown");
  });

  test("a project the token can't reach fails the check and names the permission", async () => {
    const { destination } = setup({ projects: {} });
    const check = await destination.checkAccount();
    assert(!check.ok);
    expect(check.reason).toContain(`can't read the Edge Function secrets of project ${REF}`);
    expect(check.fix).toContain("Edge Function Secrets Read-write");
  });

  test("a token that can only read secrets says which permission to add", async () => {
    const { destination, supabase } = setup({ readOnly: true });
    expect((await destination.checkAccount()).ok).toBe(true);
    const failed = await caught(destination.write("API_KEY", new Secret(VALUE)));
    expect(failed.message).toContain("give it Edge Function Secrets Read-write");
    expect(failed.message).toContain("Owner or Administrator");
    expect(supabase.effects).toEqual([]);
  });

  test("a refused write names the HTTP status and hides the value and token", async () => {
    const { destination } = setup({ failWrites: 500 });
    await destination.checkAccount();
    const failed = await caught(destination.write("API_KEY", new Secret(VALUE)));
    expect(failed.message).toContain("Supabase POST /secrets returned HTTP 500");
    expectNoneOf([VALUE, TOKEN], failed);
  });

  test("rate limiting says to wait", async () => {
    const { destination } = setup({ failWrites: 429 });
    await destination.checkAccount();
    const failed = await caught(destination.write("API_KEY", new Secret(VALUE)));
    expect(failed.message).toContain("rate-limiting");
  });

  test("a project ref keypin can't use is refused when constructing", () => {
    expect(
      () => new SupabaseSecretsDestination({ projectRef: "Acme", token: async () => TOKEN }),
    ).toThrow("isn't a Supabase project ref");
  });
});

describe("sign-in", () => {
  test("reads the token from KEYPIN_SUPABASE_ACCESS_TOKEN", async () => {
    expect(await supabaseSignIn({ [TOKEN_VARIABLE]: ` ${TOKEN} ` }).token()).toBe(TOKEN);
  });

  test("without it, says how to make one, and that SUPABASE_ACCESS_TOKEN isn't used", async () => {
    const failed = await caught(supabaseSignIn({ SUPABASE_ACCESS_TOKEN: TOKEN }).token());
    assert(failed instanceof SupabaseSignInFailed);
    expect(failed.message).toContain(`${TOKEN_VARIABLE}, which isn't set`);
    expect(failed.message).toContain("SUPABASE_ACCESS_TOKEN is set, but keypin doesn't sign in");
    expect(failed.message).toContain("Edge Function Secrets Read-write");
    expectNoneOf([TOKEN], failed);
  });

  test("an empty token is refused", async () => {
    const failed = await caught(supabaseSignIn({ [TOKEN_VARIABLE]: " " }).token());
    expect(failed.message).toContain("is set but empty");
  });

  test("the account check stops without a token, before any request", async () => {
    const target = { to: "supabase-functions", account: REF } as const;
    const destination = supabaseFunctions.connect(target, { signInEnv: {} });
    const failed = await caught(destination.checkAccount());
    assert(failed instanceof SupabaseSignInFailed);
  });

  test("check lists the sign-in step only when a key publishes to Supabase", async () => {
    const target = { to: "supabase-functions", account: REF } as const;
    const project = { folder: "/p", used: false };
    const missing = await supabaseFunctions.prerequisites?.(
      { ...project, targets: [target] },
      { env: {} },
    );
    expect(missing?.map((p) => p.status)).toEqual(["not logged in"]);
    const none = await supabaseFunctions.prerequisites?.({ ...project, targets: [] }, { env: {} });
    expect(none).toEqual([]);
    const set = { env: { [TOKEN_VARIABLE]: TOKEN } };
    expect(await supabaseFunctions.prerequisites?.({ ...project, targets: [target] }, set)).toEqual(
      [],
    );
  });
});

describe("keypin.toml", () => {
  const map = (key: string, table: string) =>
    parseMap(
      `[1password]\naccount = "my.1password.com"\n\n[keys.${key}.prod]\nfrom = "op://Private/web/credential"\n\n[[keys.${key}.prod.publish]]\n${table}`,
      "keypin.toml",
      [supabaseFunctions],
      [],
      [onePasswordVault],
    );
  const errors = (parsed: ReturnType<typeof map>) => (parsed.ok ? "" : parsed.errors.join("\n"));

  test("takes project_ref", () => {
    const parsed = map("API_KEY", `to = "supabase-functions"\nproject_ref = "${REF}"\n`);
    expect(parsed.ok ? parsed.map.keys[0]?.environments.prod?.publish : parsed.errors).toEqual([
      { to: "supabase-functions", account: REF },
    ]);
  });

  test("needs a 20-letter project_ref", () => {
    expect(errors(map("API_KEY", `to = "supabase-functions"\n`))).toContain(
      `missing field "project_ref"`,
    );
    expect(errors(map("API_KEY", `to = "supabase-functions"\nproject_ref = "acme"\n`))).toContain(
      "20-letter ref",
    );
  });

  test("refuses a key whose name starts with SUPABASE_", () => {
    const parsed = map("SUPABASE_KEY", `to = "supabase-functions"\nproject_ref = "${REF}"\n`);
    expect(errors(parsed)).toContain(
      "supabase-functions can't take this key, because Supabase reserves names that start with SUPABASE_",
    );
  });

  test("ids round-trip", () => {
    const target = { to: "supabase-functions", account: REF } as const;
    expect(supabaseFunctions.fromId(supabaseFunctions.id(target), REF)).toEqual(target);
    expect(supabaseFunctions.fromId("not a ref", REF)).toBeUndefined();
  });
});
