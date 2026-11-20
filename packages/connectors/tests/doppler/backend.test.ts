import { describe, expect, test } from "vite-plus/test";
import { type Fetch, Secret, SignInFailed, WriteRefused } from "@keypin/core";
import { day } from "@keypin/core/testing";
import { dopplerBackend, type DopplerRef } from "../../src/doppler/index";
import {
  dopplerFetch,
  type FakeDoppler,
  type FakeToken,
  memoryStore,
} from "../../src/doppler/testing";

const SENTINEL = "sentinel-value-5a1d7e";
const SERVICE = "dp.st.prd.sentinel-token-1b2c";
const READ_ONLY = "dp.st.prd.read-only-token-8e9f";
const ACCOUNT = "dp.sa.sentinel-account-3d4e";
const PERSONAL = "dp.pt.sentinel-personal-6f7a";

const REF: DopplerRef = {
  kind: "doppler",
  workplace: "acme",
  project: "billing",
  config: "prd",
  name: "STRIPE_KEY",
};

const TOKENS: Record<string, FakeToken> = {
  [SERVICE]: { type: "service_token", project: "billing", config: "prd", access: "read/write" },
  [READ_ONLY]: { type: "service_token", project: "billing", config: "prd", access: "read" },
  [ACCOUNT]: { type: "service_account", write: true },
  [PERSONAL]: { type: "personal" },
};

function setup(
  token: string | null,
  options: {
    secrets?: FakeDoppler["projects"];
    inherits?: FakeDoppler["inherits"];
    workplace?: string;
    failWrites?: boolean;
  } = {},
) {
  const store = memoryStore();
  const fake: FakeDoppler = {
    workplace: options.workplace ?? "acme",
    projects: options.secrets ?? {
      billing: {
        prd: { STRIPE_KEY: { value: SENTINEL } },
        dev: { STRIPE_KEY: { value: `${SENTINEL}-dev` } },
      },
    },
    tokens: TOKENS,
    ...(options.inherits ? { inherits: options.inherits } : {}),
    ...(options.failWrites ? { failWrites: true } : {}),
  };
  const calls: string[] = [];
  const fetch = dopplerFetch(fake, store);
  const spy: Fetch = (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(`${init.method} ${pathname}${searchParams.size ? `?${searchParams}` : ""}`);
    return fetch(url, init);
  };
  return { vault: dopplerBackend(token === null ? null : { token }, spy), store, calls };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return error;
    },
  );

describe("signing in to Doppler", () => {
  test("no token is no-credentials, naming DOPPLER_TOKEN, with no request", async () => {
    const { vault, calls } = setup(null);
    const error = await failure(vault.read(REF));
    expect(error).toBeInstanceOf(SignInFailed);
    expect(error instanceof SignInFailed && error.reason).toEqual({ kind: "no-credentials" });
    expect(error.message).toContain("set DOPPLER_TOKEN to a Doppler service token");
    expect(calls).toEqual([]);
  });

  test("a refused token names its kind and the variable, never the token", async () => {
    const { vault } = setup("dp.st.prd.revoked-token-0000");
    const error = await failure(vault.read(REF));
    expect(error.message).toBe(
      "Doppler workplace acme: sign-in failed: Doppler refused the service token in DOPPLER_TOKEN (HTTP 401); it may be revoked or expired, so make a new one",
    );
  });

  test("a token from another workplace is wrong-account, before any secret is read", async () => {
    const { vault, calls } = setup(SERVICE, { workplace: "globex" });
    const error = await failure(vault.read(REF));
    expect(error instanceof SignInFailed && error.reason).toEqual({
      kind: "wrong-account",
      pinned: "acme",
      actual: "globex",
    });
    expect(error.message).toContain(
      "the service token in DOPPLER_TOKEN belongs to the workplace globex Inc (globex), but keypin.toml pins acme",
    );
    expect(calls).toEqual(["GET /v3/me"]);
  });

  test("signs in once for many reads", async () => {
    const { vault, calls } = setup(ACCOUNT);
    await vault.read(REF);
    await vault.read({ ...REF, config: "dev" });
    expect(calls.filter((call) => call === "GET /v3/me")).toHaveLength(1);
  });
});

describe("reading", () => {
  test("a service token for another config says it reads only its own config", async () => {
    const { vault } = setup(SERVICE);
    const error = await failure(vault.read({ ...REF, config: "dev" }));
    expect(error.message).toBe(
      "doppler://billing/dev/STRIPE_KEY (Doppler workplace acme): Doppler returned HTTP 403: This token does not have access to requested config; a service token reads only the config it was made for, so use one made for billing/dev, or a service account token",
    );
  });

  test("a missing secret says so", async () => {
    const { vault } = setup(ACCOUNT);
    const error = await failure(vault.read({ ...REF, name: "NOPE" }));
    expect(error.message).toBe(
      "doppler://billing/prd/NOPE (Doppler workplace acme): Doppler returned HTTP 404: Could not find requested secret",
    );
    await expect(vault.itemIds({ ...REF, name: "NOPE" })).rejects.toThrow(
      "doppler://billing/prd/NOPE (Doppler workplace acme): no secret NOPE in billing/prd",
    );
  });

  test("reads the computed value, with references resolved", async () => {
    const secrets = {
      billing: { prd: { STRIPE_KEY: { value: "${prd.ROOT_KEY}" }, ROOT_KEY: { value: SENTINEL } } },
    };
    const { vault } = setup(ACCOUNT, { secrets });
    expect((await vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
  });

  test("an empty value is refused", async () => {
    const { vault } = setup(ACCOUNT, {
      secrets: { billing: { prd: { STRIPE_KEY: { value: "" } } } },
    });
    await expect(vault.read(REF)).rejects.toThrow(
      "doppler://billing/prd/STRIPE_KEY (Doppler workplace acme): the value is empty",
    );
  });

  test("a restricted secret read with a personal token says to use a service token", async () => {
    const { vault } = setup(PERSONAL, {
      secrets: { billing: { prd: { STRIPE_KEY: { value: SENTINEL, restricted: true } } } },
    });
    const error = await failure(vault.read(REF));
    expect(error.message).toBe(
      "doppler://billing/prd/STRIPE_KEY (Doppler workplace acme): Doppler hides this restricted secret's value from a personal token; use a service token or service account token",
    );
  });

  test("ids are the config and the secret's name, and metadata has no rotated date", async () => {
    const { vault } = setup(SERVICE);
    expect(await vault.itemIds(REF)).toEqual({ vault: "billing/prd", item: "STRIPE_KEY" });
    expect(await vault.metadata(REF)).toEqual({ rotated: null });
  });

  test("list names the config's secrets without reading a value", async () => {
    const { vault, calls } = setup(SERVICE);
    const items = await vault.list({
      kind: "doppler",
      workplace: "acme",
      project: "billing",
      config: "prd",
    });
    expect(items).toEqual([{ id: "STRIPE_KEY", title: "STRIPE_KEY", tags: [], updatedAt: "" }]);
    expect(calls.some((call) => call.startsWith("GET /v3/configs/config/secret?"))).toBe(false);
  });
});

describe("writing", () => {
  test("saves one secret in its config, and only it", async () => {
    const { vault, store } = setup(SERVICE);
    await vault.write(REF, new Secret(`${SENTINEL}-2`), { rotated: day("2026-11-17") });
    expect(store.effects).toEqual(["doppler update billing/prd/STRIPE_KEY"]);
    expect((await vault.read(REF)).equals(new Secret(`${SENTINEL}-2`))).toBe(true);
  });

  test("a read-only service token is refused, saying to make a read/write one", async () => {
    const { vault, store } = setup(READ_ONLY);
    const error = await failure(vault.write(REF, new Secret(`${SENTINEL}-2`)));
    expect(error).toBeInstanceOf(WriteRefused);
    expect(error.message).toBe(
      "doppler://billing/prd/STRIPE_KEY (Doppler workplace acme): Doppler returned HTTP 403: You do not have permission to perform this action; keypin needs a service token with write access to billing/prd, so make a service token with read/write access",
    );
    expect(store.effects).toEqual([]);
  });

  test("a service account without write access is refused", async () => {
    const store = memoryStore();
    const fake: FakeDoppler = {
      workplace: "acme",
      projects: { billing: { prd: { STRIPE_KEY: { value: SENTINEL } } } },
      tokens: { [ACCOUNT]: { type: "service_account" } },
    };
    const vault = dopplerBackend({ token: ACCOUNT }, dopplerFetch(fake, store));
    await expect(vault.write(REF, new Secret("x"))).rejects.toThrow(
      "keypin needs a service account token with write access to billing/prd",
    );
  });

  test("a server error is not a refusal, so rotate checks what Doppler holds", async () => {
    const { vault } = setup(SERVICE, { failWrites: true });
    const error = await failure(vault.write(REF, new Secret("x")));
    expect(error).not.toBeInstanceOf(WriteRefused);
    expect(error.message).toContain("Doppler returned HTTP 500: internal error");
  });

  test("a secret that references another is refused, naming the source", async () => {
    const secrets = {
      billing: { prd: { STRIPE_KEY: { value: "${shared.prd.STRIPE_KEY}" } } },
      shared: { prd: { STRIPE_KEY: { value: SENTINEL } } },
    };
    const { vault, store } = setup(ACCOUNT, { secrets });
    const message =
      "doppler://billing/prd/STRIPE_KEY (Doppler workplace acme): the secret references doppler://shared/prd/STRIPE_KEY, so a new key saved here would leave that secret, and everything that uses it, with the old key; point keypin.toml at doppler://shared/prd/STRIPE_KEY instead";
    await expect(vault.checkWrite?.(REF)).rejects.toThrow(message);
    const error = await failure(vault.write(REF, new Secret("x")));
    expect(error).toBeInstanceOf(WriteRefused);
    expect(error.message).toBe(message);
    expect(store.effects).toEqual([]);
  });

  test.each([
    ["${KEY}", "doppler://billing/prd/KEY"],
    ["${dev.KEY}", "doppler://billing/dev/KEY"],
    ['${dev."stripe.key"}', "doppler://billing/dev/stripe.key"],
  ])("names the source of %s", async (raw, source) => {
    const { vault } = setup(ACCOUNT, {
      secrets: { billing: { prd: { STRIPE_KEY: { value: raw } }, dev: {} } },
    });
    await expect(vault.checkWrite?.(REF)).rejects.toThrow(`the secret references ${source},`);
  });

  test("a restricted secret can't be checked with a personal token", async () => {
    const { vault } = setup(PERSONAL, {
      secrets: { billing: { prd: { STRIPE_KEY: { value: SENTINEL, restricted: true } } } },
    });
    await expect(vault.checkWrite?.(REF)).rejects.toThrow(
      "Doppler hides this restricted secret's value from a personal token, so keypin can't tell whether it references another secret",
    );
  });

  test("a branch config's secret inherited from its root is read, but not written", async () => {
    const branch = { ...REF, config: "prd_aws" };
    const { vault, store } = setup(ACCOUNT, {
      secrets: { billing: { prd: { STRIPE_KEY: { value: SENTINEL } }, prd_aws: {} } },
    });
    expect((await vault.read(branch)).equals(new Secret(SENTINEL))).toBe(true);
    const message =
      "doppler://billing/prd_aws/STRIPE_KEY (Doppler workplace acme): billing/prd_aws inherits doppler://billing/prd/STRIPE_KEY, and Doppler doesn't say whether the secret here overrides it, so a new key saved here could leave that secret, and every config that inherits it, with the old key; point keypin.toml at doppler://billing/prd/STRIPE_KEY instead";
    await expect(vault.checkWrite?.(branch)).rejects.toThrow(message);
    const error = await failure(vault.write(branch, new Secret("x")));
    expect(error).toBeInstanceOf(WriteRefused);
    expect(error.message).toBe(message);
    expect(store.effects).toEqual([]);
  });

  test("a branch config's override of its root's secret is refused too", async () => {
    const branch = { ...REF, config: "prd_aws" };
    const { vault } = setup(ACCOUNT, {
      secrets: {
        billing: {
          prd: { STRIPE_KEY: { value: SENTINEL } },
          prd_aws: { STRIPE_KEY: { value: `${SENTINEL}-aws` } },
        },
      },
    });
    expect((await vault.read(branch)).equals(new Secret(`${SENTINEL}-aws`))).toBe(true);
    await expect(vault.checkWrite?.(branch)).rejects.toThrow(
      "billing/prd_aws inherits doppler://billing/prd/STRIPE_KEY,",
    );
  });

  test("a branch config's own secret, with none of that name in its root, is written", async () => {
    const branch = { ...REF, config: "prd_aws" };
    const { vault, store } = setup(ACCOUNT, {
      secrets: {
        billing: {
          prd: { OTHER_KEY: { value: SENTINEL } },
          prd_aws: { STRIPE_KEY: { value: `${SENTINEL}-aws` } },
        },
      },
    });
    await vault.checkWrite?.(branch);
    await vault.write(branch, new Secret(`${SENTINEL}-2`));
    expect(store.effects).toEqual(["doppler update billing/prd_aws/STRIPE_KEY"]);
  });

  test("a secret inherited from another project's config is refused, naming it", async () => {
    const { vault, store } = setup(ACCOUNT, {
      secrets: {
        billing: { prd: { OTHER_KEY: { value: SENTINEL } } },
        shared: { prd: { STRIPE_KEY: { value: `${SENTINEL}-shared` } } },
      },
      inherits: { "billing/prd": [{ project: "shared", config: "prd" }] },
    });
    expect((await vault.read(REF)).equals(new Secret(`${SENTINEL}-shared`))).toBe(true);
    const error = await failure(vault.write(REF, new Secret("x")));
    expect(error).toBeInstanceOf(WriteRefused);
    expect(error.message).toContain("point keypin.toml at doppler://shared/prd/STRIPE_KEY instead");
    expect(store.effects).toEqual([]);
  });

  test("a service token for a branch config can't read its root, so the write is refused", async () => {
    const token = "dp.st.prd_aws.sentinel-token-2c3d";
    const store = memoryStore();
    const fake: FakeDoppler = {
      workplace: "acme",
      projects: { billing: { prd: {}, prd_aws: { STRIPE_KEY: { value: SENTINEL } } } },
      tokens: {
        [token]: {
          type: "service_token",
          project: "billing",
          config: "prd_aws",
          access: "read/write",
        },
      },
    };
    const vault = dopplerBackend({ token }, dopplerFetch(fake, store));
    const branch = { ...REF, config: "prd_aws" };
    expect((await vault.read(branch)).equals(new Secret(SENTINEL))).toBe(true);
    const error = await failure(vault.write(branch, new Secret("x")));
    expect(error).toBeInstanceOf(WriteRefused);
    expect(error.message).toBe(
      "doppler://billing/prd_aws/STRIPE_KEY (Doppler workplace acme): keypin can't read the configs of billing, so it can't tell whether the secret is inherited from another config: Doppler returned HTTP 403: This token does not have access to requested config; a service token reads only the config it was made for, so use a service account token or personal token that can read it",
    );
    expect(store.effects).toEqual([]);
  });

  test("a new item that already exists is refused without writing", async () => {
    const { vault, store } = setup(SERVICE);
    const error = await failure(vault.write(REF, new Secret("x"), { newItem: true }));
    expect(error).toBeInstanceOf(WriteRefused);
    expect(store.effects).toEqual([]);
  });

  test("a new item is created", async () => {
    const { vault, store } = setup(SERVICE);
    await vault.write({ ...REF, name: "NEW_KEY" }, new Secret(`${SENTINEL}-new`), {
      newItem: true,
    });
    expect(store.effects).toEqual(["doppler create billing/prd/NEW_KEY"]);
  });
});
