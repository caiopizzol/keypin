import { describe, expect, test } from "vite-plus/test";
import { type Fetch, Secret, SignInFailed, WriteRefused } from "@keypin/core";
import { day, expectNoneOf } from "@keypin/core/testing";
import { accessTokenFrom, bitwardenBackend, type BitwardenRef } from "../../src/bitwarden/index";
import {
  bitwardenFetch,
  FAKE_ACCESS_TOKEN,
  type FakeBitwarden,
  type FakeSecret,
  memoryStore,
} from "../../src/bitwarden/testing";

const ORGANIZATION = "2f1d6c9e-8a3b-4c5d-9e7f-0a1b2c3d4e5f";
const SENTINEL = "sentinel-value-5b2e8d";
const TOKEN_SECRET = "fake-machine-account-secret-7d2e";
const REF: BitwardenRef = {
  kind: "bitwarden",
  url: "https://vault.bitwarden.com",
  organization: ORGANIZATION,
  project: "billing",
  name: "STRIPE_KEY",
};

async function caught(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("expected a rejection with an Error");
  return outcome;
}

function setup(
  options: {
    secrets?: FakeSecret[];
    projects?: FakeBitwarden["projects"];
    organization?: string;
    env?: Record<string, string>;
  } & Partial<Pick<FakeBitwarden, "refuseLogin" | "failWrites" | "rateLimited">> = {},
) {
  const { secrets, projects, organization, env, ...rest } = options;
  const fake: FakeBitwarden = {
    organization: organization ?? ORGANIZATION,
    projects: projects ?? {
      billing: { secrets: secrets ?? [{ name: "STRIPE_KEY", value: SENTINEL }] },
    },
    ...rest,
  };
  const store = memoryStore();
  const calls: string[] = [];
  const served = bitwardenFetch(fake, store);
  const fetch: Fetch = (url, init) => {
    calls.push(`${init.method} ${url}`);
    return served(url, init);
  };
  const slept: number[] = [];
  const vault = bitwardenBackend(
    accessTokenFrom(env ?? { BWS_ACCESS_TOKEN: FAKE_ACCESS_TOKEN }),
    fetch,
    async (ms) => void slept.push(ms),
  );
  return { fake, store, calls, slept, vault };
}

describe("signing in to Bitwarden", () => {
  test("no access token is no-credentials, and nothing is asked", async () => {
    const { vault, calls } = setup({ env: {} });
    const error = await caught(vault.read(REF));
    expect(error).toBeInstanceOf(SignInFailed);
    expect(error).toMatchObject({ reason: { kind: "no-credentials" } });
    expect(error.message).toContain("set BWS_ACCESS_TOKEN to a machine account's access token");
    expect(calls).toEqual([]);
  });

  test("a value that isn't an access token is refused before any request", async () => {
    const { vault, calls } = setup({ env: { BWS_ACCESS_TOKEN: "bws-personal-api-key" } });
    const error = await caught(vault.read(REF));
    expect(error).toBeInstanceOf(SignInFailed);
    expect(error.message).toContain("isn't a Bitwarden Secrets Manager access token");
    expect(error.message).not.toContain("bws-personal-api-key");
    expect(calls).toEqual([]);
  });

  test("a revoked token is a sign-in failure that never shows the token", async () => {
    const { vault } = setup({ refuseLogin: true });
    const error = await caught(vault.read(REF));
    expect(error).toBeInstanceOf(SignInFailed);
    expect(error.message).toContain("Bitwarden refused the access token in BWS_ACCESS_TOKEN");
    expectNoneOf([TOKEN_SECRET, SENTINEL], error);
  });

  test("a machine account in another organization is wrong-account", async () => {
    const other = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
    const { vault } = setup({ organization: other });
    const error = await caught(vault.read(REF));
    expect(error).toMatchObject({
      reason: { kind: "wrong-account", pinned: ORGANIZATION, actual: other },
    });
  });

  test("the EU cloud and a self-hosted server use their own identity and API addresses", async () => {
    for (const [url, identity, api] of [
      ["https://vault.bitwarden.eu", "https://identity.bitwarden.eu", "https://api.bitwarden.eu"],
      ["https://bw.example.com", "https://bw.example.com/identity", "https://bw.example.com/api"],
    ]) {
      const { vault, calls } = setup();
      expect((await vault.read({ ...REF, url: url ?? "" })).equals(new Secret(SENTINEL))).toBe(
        true,
      );
      expect(calls[0]).toBe(`POST ${identity}/connect/token`);
      expect(calls[1]).toBe(`GET ${api}/organizations/${ORGANIZATION}/projects`);
    }
  });

  test("signs in once for many reads", async () => {
    const { vault, calls } = setup();
    await vault.read(REF);
    await vault.metadata(REF);
    expect(calls.filter((call) => call.endsWith("/connect/token"))).toHaveLength(1);
    expect(calls.filter((call) => call.endsWith("/projects"))).toHaveLength(1);
  });

  test("waits out a short rate limit once, and names a long one", async () => {
    const short = setup({ rateLimited: { times: 1, retryAfter: 2 } });
    await short.vault.read(REF);
    expect(short.slept).toEqual([2000]);
    const long = setup({ rateLimited: { times: 1 } });
    const error = await caught(long.vault.read(REF));
    expect(error).toBeInstanceOf(SignInFailed);
    expect(error.message).toContain("Bitwarden is limiting how often keypin can ask");
  });
});

describe("finding a secret", () => {
  test("a project is found by name or by ID", async () => {
    const id = "a3c1e2f4-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
    const projects = { billing: { id, secrets: [{ name: "STRIPE_KEY", value: SENTINEL }] } };
    const { vault } = setup({ projects });
    expect((await vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    expect(
      (await vault.read({ ...REF, project: id.toUpperCase() })).equals(new Secret(SENTINEL)),
    ).toBe(true);
    expect((await vault.itemIds(REF)).vault).toBe(id);
  });

  test("an unknown project names the fix", async () => {
    const { vault } = setup();
    const error = await caught(vault.read({ ...REF, project: "payments" }));
    expect(error.message).toContain(
      'no project "payments" that the machine account can read; add the machine account to the project, or check its name',
    );
  });

  test("two projects with one name ask for the ID", async () => {
    const { vault } = setup({
      projects: {
        billing: { id: "11111111-1111-4111-8111-111111111111", secrets: [] },
        "billing copy": {
          id: "22222222-2222-4222-8222-222222222222",
          secrets: [],
          name: "billing",
        },
      },
    });
    const error = await caught(vault.read(REF));
    expect(error.message).toContain(
      '2 projects are named "billing"; use the project\'s ID instead (11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222)',
    );
  });

  test("two secrets with the key name are refused, for reads and writes", async () => {
    const { vault, store } = setup({
      secrets: [
        { name: "STRIPE_KEY", value: SENTINEL },
        { name: "STRIPE_KEY", value: `${SENTINEL}-2` },
      ],
    });
    for (const attempt of [vault.read(REF), vault.write(REF, new Secret("new-value-1234"))]) {
      const error = await caught(attempt);
      expect(error.message).toContain(
        "2 secrets in the project are named STRIPE_KEY, so keypin can't tell which one to use",
      );
      expectNoneOf([SENTINEL], error);
    }
    expect(store.effects).toEqual([]);
  });

  test("a missing secret says so", async () => {
    const { vault } = setup({ secrets: [] });
    const error = await caught(vault.read(REF));
    expect(error.message).toContain("no secret named STRIPE_KEY in the project");
  });

  test("list names the secrets and reads no value", async () => {
    const { vault, calls } = setup();
    const { name: _, ...scope } = REF;
    const items = await vault.list(scope);
    expect(items.map((item) => item.title)).toEqual(["STRIPE_KEY"]);
    expect(calls.some((call) => /\/secrets\/[^/]+$/.test(call))).toBe(false);
  });
});

describe("the rotated date in the secret's note", () => {
  test("status reads it from a line in the note", async () => {
    const { vault } = setup({
      secrets: [
        { name: "STRIPE_KEY", value: SENTINEL, note: "owner: billing\nrotated: 2026-09-30" },
      ],
    });
    expect(await vault.metadata(REF)).toEqual({ rotated: day("2026-09-30") });
  });

  test("no line is no date, and a bad one is an error", async () => {
    const none = setup({
      secrets: [{ name: "STRIPE_KEY", value: SENTINEL, note: "owner: billing" }],
    });
    expect(await none.vault.metadata(REF)).toEqual({ rotated: null });
    const bad = setup({
      secrets: [{ name: "STRIPE_KEY", value: SENTINEL, note: "rotated: soon" }],
    });
    const error = await caught(bad.vault.metadata(REF));
    expect(error.message).toContain(`the note's rotated line isn't a YYYY-MM-DD date: "soon"`);
  });

  test("a write keeps the rest of the note and replaces only the rotated line", async () => {
    const { vault, store } = setup({
      secrets: [
        {
          name: "STRIPE_KEY",
          value: SENTINEL,
          note: "owner: billing\nrotated: 2026-01-01\nsee runbook",
        },
      ],
    });
    await vault.write(REF, new Secret("new-value-1234"), { rotated: day("2026-11-17") });
    expect(store.load()[0]).toMatchObject({
      name: "STRIPE_KEY",
      value: "new-value-1234",
      note: "owner: billing\nrotated: 2026-11-17\nsee runbook",
    });
  });

  test("a write without a rotated date leaves the note alone", async () => {
    const { vault, store } = setup({
      secrets: [{ name: "STRIPE_KEY", value: SENTINEL, note: "owner: billing" }],
    });
    await vault.write(REF, new Secret("new-value-1234"));
    expect(store.load()[0]?.note).toBe("owner: billing");
  });
});

describe("saving a value", () => {
  test("a read-only machine account is refused before rotate creates a key, and on write", async () => {
    const { vault, store } = setup({
      projects: { billing: { readOnly: true, secrets: [{ name: "STRIPE_KEY", value: SENTINEL }] } },
    });
    const check = await caught(Promise.resolve(vault.checkWrite?.(REF)));
    expect(check.message).toContain(
      "the machine account can read this secret but not change it; give it Can read, write on the project",
    );
    expect(await caught(vault.write(REF, new Secret("new-value-1234")))).toBeInstanceOf(
      WriteRefused,
    );
    expect(store.effects).toEqual([]);
  });

  test("a secret renamed after keypin listed it is refused, not overwritten", async () => {
    const { vault, store } = setup();
    const { ids } = await vault.readItem(REF);
    store.save({
      id: ids.item,
      project: ids.vault,
      name: "RENAMED_KEY",
      value: SENTINEL,
      note: "",
    });
    const error = await caught(vault.write(REF, new Secret("new-value-1234")));
    expect(error).toBeInstanceOf(WriteRefused);
    expect(error.message).toContain(
      "the secret changed while keypin ran (it's now named RENAMED_KEY)",
    );
    expect(store.effects).toEqual([]);
    expect(store.load().find((entry) => entry.id === ids.item)?.value).toBe(SENTINEL);
  });

  test("keypin doesn't create Bitwarden secrets", async () => {
    const { vault, store } = setup();
    const error = await caught(vault.write(REF, new Secret("new-value-1234"), { newItem: true }));
    expect(error.message).toContain("keypin doesn't create Bitwarden secrets");
    expect(store.effects).toEqual([]);
  });

  test("a server error is an error whose outcome isn't known, not a refusal", async () => {
    const { vault } = setup({ failWrites: true });
    const error = await caught(vault.write(REF, new Secret("new-value-1234")));
    expect(error).not.toBeInstanceOf(WriteRefused);
    expect(error.message).toContain("Bitwarden returned HTTP 500");
  });

  test("an empty value isn't read as a key", async () => {
    const { vault } = setup({ secrets: [{ name: "STRIPE_KEY", value: "" }] });
    expect((await caught(vault.read(REF))).message).toContain("the value is empty");
  });
});
