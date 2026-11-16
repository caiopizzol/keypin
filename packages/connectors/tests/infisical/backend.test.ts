import { describe, expect, test } from "vite-plus/test";
import { type Fetch, isRecord, Secret } from "@keypin/core";
import { credentialsFrom, infisicalBackend, type InfisicalRef } from "../../src/infisical/index";
import {
  type FakeInfisical,
  type FakeSecret,
  infisicalFetch,
  memoryStore,
} from "../../src/infisical/testing";

const URL = "https://app.infisical.com";
const PROJECT_ID = "6f1c2a4e-1111-4222-8333-944455556666";
const SENTINEL = "sentinel-value-3c9e1f";
const CLIENT_SECRET = "client-secret-sentinel-7a2d";
const CREDENTIALS = { clientId: "client-id-1", clientSecret: CLIENT_SECRET };

const REF: InfisicalRef = {
  kind: "infisical",
  url: URL,
  organization: "acme",
  project: "billing",
  environment: "prod",
  path: "/",
  name: "STRIPE_KEY",
};

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | null;
  body: Record<string, unknown> | null;
}

function fakeInfisical(
  options: {
    secrets?: Record<string, FakeSecret>;
    organization?: string;
    login?: number;
    hidden?: boolean;
    approval?: boolean;
    encryptedMetadata?: boolean;
  } = {},
) {
  const store = memoryStore();
  const fake: FakeInfisical = {
    organization: options.organization ?? "acme",
    projects: { billing: { prod: {}, dev: {} } },
    projectIds: { billing: PROJECT_ID },
    ...(options.login ? { refuseLogin: options.login } : {}),
    ...(options.hidden ? { hideValues: true } : {}),
    ...(options.approval ? { heldByPolicy: [] } : {}),
    ...(options.encryptedMetadata ? { requireEncryptedMetadata: true } : {}),
  };
  for (const [where, secret] of Object.entries(options.secrets ?? {})) {
    const [environment = "", path = "/", name = ""] = where.split(":");
    const key = path === "/" ? name : `${path}/${name}`;
    const environments = (fake.projects.billing ??= {});
    (environments[environment] ??= {})[key] = secret;
  }
  const calls: Call[] = [];
  const served = infisicalFetch(fake, store);
  const fetch: Fetch = (url, init) => {
    const parsed = new globalThis.URL(url);
    const sent: unknown = init.body ? JSON.parse(init.body) : null;
    calls.push({
      method: init.method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      auth: init.headers.Authorization ?? null,
      body: isRecord(sent) ? sent : null,
    });
    return served(url, init);
  };
  const saved = (name: string) => store.load().find((entry) => entry.name === name)?.secret;
  return { fetch, calls, saved, effects: store.effects };
}

const STRIPE: FakeSecret = {
  id: "secret-1",
  value: SENTINEL,
  rotated: "2026-10-01",
  tags: ["billing"],
};

describe("signing in", () => {
  test("logs in with Universal Auth once, checks the organization, and resolves the project slug once", async () => {
    const fake = fakeInfisical({ secrets: { "prod:/:STRIPE_KEY": STRIPE } });
    const vault = infisicalBackend(CREDENTIALS, fake.fetch);
    expect((await vault.read(REF)).equals(new Secret(SENTINEL))).toBe(true);
    await vault.read(REF);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/auth/universal-auth/login",
      "GET /api/v1/identities/details",
      "GET /api/v1/projects/slug/billing",
      "GET /api/v4/secrets/STRIPE_KEY",
      "GET /api/v4/secrets/STRIPE_KEY",
    ]);
    expect(fake.calls[0]?.body).toEqual({ clientId: "client-id-1", clientSecret: CLIENT_SECRET });
    expect(fake.calls[3]?.query).toMatchObject({
      projectId: PROJECT_ID,
      environment: "prod",
      secretPath: "/",
      viewSecretValue: "true",
    });
  });

  test("a project ID in the reference skips the slug lookup", async () => {
    const fake = fakeInfisical({ secrets: { "prod:/:STRIPE_KEY": STRIPE } });
    await infisicalBackend(CREDENTIALS, fake.fetch).read({ ...REF, project: PROJECT_ID });
    expect(fake.calls.some((c) => c.path.startsWith("/api/v1/projects"))).toBe(false);
  });

  test("a self-hosted url is where every request goes", async () => {
    const fake = fakeInfisical({ secrets: { "prod:/:STRIPE_KEY": STRIPE } });
    const urls: string[] = [];
    await infisicalBackend(CREDENTIALS, (url, init) => {
      urls.push(url);
      return fake.fetch(url, init);
    }).read({ ...REF, url: "https://vault.acme.dev" });
    expect(urls.every((url) => url.startsWith("https://vault.acme.dev/api/"))).toBe(true);
  });

  test("no credentials name the variables to set", async () => {
    await expect(infisicalBackend(null, fakeInfisical().fetch).read(REF)).rejects.toThrow(
      "Infisical organization acme at https://app.infisical.com: sign-in failed: set INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET to a machine identity's Universal Auth client ID and secret",
    );
  });

  test("refused credentials say so, without the secret", async () => {
    const fake = fakeInfisical({ login: 401 });
    const error = await infisicalBackend(CREDENTIALS, fake.fetch)
      .read(REF)
      .catch((e: unknown) => e);
    expect(String(error)).toContain(
      "sign-in failed: Infisical returned HTTP 401: Invalid credentials",
    );
    expect(String(error)).not.toContain(CLIENT_SECRET);
  });

  test("an identity from another organization is refused before any secret is read", async () => {
    const fake = fakeInfisical({ organization: "other", secrets: { "prod:/:STRIPE_KEY": STRIPE } });
    await expect(infisicalBackend(CREDENTIALS, fake.fetch).read(REF)).rejects.toThrow(
      "sign-in failed: the machine identity belongs to the organization other, but keypin.toml pins acme",
    );
    expect(fake.calls.some((c) => c.path.startsWith("/api/v4"))).toBe(false);
  });

  test("an unknown project names the slug", async () => {
    await expect(
      infisicalBackend(CREDENTIALS, fakeInfisical().fetch).read({ ...REF, project: "nope" }),
    ).rejects.toThrow(`no project with the slug "nope", or the machine identity isn't a member`);
  });

  test("credentials come from both variables, or not at all", () => {
    expect(
      credentialsFrom({
        INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "a",
        INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "b",
      }),
    ).toEqual({ clientId: "a", clientSecret: "b" });
    expect(credentialsFrom({ INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "a" })).toBeNull();
  });
});

describe("reading", () => {
  test("readItem gives the value and the project and secret IDs", async () => {
    const fake = fakeInfisical({ secrets: { "prod:/:STRIPE_KEY": STRIPE } });
    const { secret, ids } = await infisicalBackend(CREDENTIALS, fake.fetch).readItem(REF);
    expect(secret.equals(new Secret(SENTINEL))).toBe(true);
    expect(ids).toEqual({ vault: PROJECT_ID, item: "secret-1" });
  });

  test("itemIds and metadata never ask for the value", async () => {
    const fake = fakeInfisical({ secrets: { "prod:/:STRIPE_KEY": STRIPE } });
    const vault = infisicalBackend(CREDENTIALS, fake.fetch);
    expect(await vault.itemIds(REF)).toEqual({ vault: PROJECT_ID, item: "secret-1" });
    expect(await vault.metadata(REF)).toEqual({ rotated: "2026-10-01" });
    const reads = fake.calls.filter((c) => c.path === "/api/v4/secrets/STRIPE_KEY");
    expect(reads.map((c) => c.query.viewSecretValue)).toEqual(["false", "false"]);
  });

  test("a folder reference reads that secret path", async () => {
    const fake = fakeInfisical({ secrets: { "prod:/payments/stripe:STRIPE_KEY": STRIPE } });
    const ref = { ...REF, path: "/payments/stripe" };
    expect((await infisicalBackend(CREDENTIALS, fake.fetch).read(ref)).isEmpty()).toBe(false);
  });

  test("a missing secret, a hidden value, and a bad rotated date are clear errors", async () => {
    const missing = infisicalBackend(CREDENTIALS, fakeInfisical().fetch);
    await expect(missing.read(REF)).rejects.toThrow(
      "infisical://billing/prod/STRIPE_KEY (Infisical organization acme at https://app.infisical.com): no such secret",
    );
    const hidden = fakeInfisical({ hidden: true, secrets: { "prod:/:STRIPE_KEY": STRIPE } });
    await expect(infisicalBackend(CREDENTIALS, hidden.fetch).read(REF)).rejects.toThrow(
      "the machine identity can see this secret but not its value",
    );
    const bad = fakeInfisical({
      secrets: {
        "prod:/:STRIPE_KEY": { ...STRIPE, rotated: "soon" },
      },
    });
    await expect(infisicalBackend(CREDENTIALS, bad.fetch).metadata(REF)).rejects.toThrow(
      `the metadata "rotated" isn't a YYYY-MM-DD date: "soon"`,
    );
  });

  test("no rotated metadata is no rotated date", async () => {
    const fake = fakeInfisical({ secrets: { "prod:/:STRIPE_KEY": { ...STRIPE, rotated: "" } } });
    expect(await infisicalBackend(CREDENTIALS, fake.fetch).metadata(REF)).toEqual({
      rotated: null,
    });
  });

  test("a 1Password reference is refused", async () => {
    const ref = {
      kind: "1password" as const,
      account: "my.1password.com",
      vault: "Private",
      item: "i",
      section: null,
      field: "password",
    };
    await expect(infisicalBackend(CREDENTIALS, fakeInfisical().fetch).read(ref)).rejects.toThrow(
      "keypin's Infisical vault can't read this reference",
    );
  });
});

describe("writing", () => {
  test("updating keeps other metadata and sets rotated", async () => {
    const fake = fakeInfisical({
      secrets: {
        "prod:/:STRIPE_KEY": {
          ...STRIPE,
          metadata: [{ key: "owner", value: "billing" }],
        },
      },
    });
    await infisicalBackend(CREDENTIALS, fake.fetch).write(REF, new Secret("new-value-1234"), {
      rotated: "2026-11-14",
    });
    const patch = fake.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({
      projectId: PROJECT_ID,
      environment: "prod",
      secretPath: "/",
      secretValue: "new-value-1234",
      secretMetadata: [
        { key: "owner", value: "billing" },
        { key: "rotated", value: "2026-11-14", isEncrypted: true },
      ],
    });
    expect(
      fake.calls.find((c) => c.method === "GET" && c.path.endsWith("/STRIPE_KEY"))?.query
        .includeImports,
    ).toBe("false");
  });

  test("a new secret is created, and newItem refuses one that exists", async () => {
    const fake = fakeInfisical({ secrets: { "prod:/:STRIPE_KEY": STRIPE } });
    const vault = infisicalBackend(CREDENTIALS, fake.fetch);
    await vault.write({ ...REF, name: "RESEND_KEY" }, new Secret("resend-value-99"), {
      newItem: true,
      rotated: "2026-11-14",
    });
    expect(fake.calls.at(-1)).toMatchObject({ method: "POST", path: "/api/v4/secrets/RESEND_KEY" });
    expect(fake.saved("RESEND_KEY")).toMatchObject({ rotated: "2026-11-14" });
    await expect(vault.write(REF, new Secret("x"), { newItem: true })).rejects.toThrow(
      "the secret already exists; keypin doesn't overwrite it",
    );
  });

  test("rotated is sent encrypted, so projects that require encrypted metadata accept it", async () => {
    const fake = fakeInfisical({
      encryptedMetadata: true,
      secrets: {
        "prod:/:STRIPE_KEY": {
          ...STRIPE,
          rotated: "",
          metadata: [{ key: "rotated", value: "2026-10-01", isEncrypted: true }],
        },
      },
    });
    const vault = infisicalBackend(CREDENTIALS, fake.fetch);
    await vault.write(REF, new Secret("new-value-1234"), { rotated: "2026-11-14" });
    await vault.write({ ...REF, name: "RESEND_KEY" }, new Secret("resend-value-99"), {
      newItem: true,
      rotated: "2026-11-14",
    });
    expect(fake.saved("STRIPE_KEY")).toMatchObject({ rotated: "2026-11-14" });
    expect(fake.saved("RESEND_KEY")).toMatchObject({ rotated: "2026-11-14" });
    expect(await vault.metadata(REF)).toEqual({ rotated: "2026-11-14" });
  });

  test("a change held for approval isn't reported as written", async () => {
    const fake = fakeInfisical({ approval: true, secrets: { "prod:/:STRIPE_KEY": STRIPE } });
    await expect(
      infisicalBackend(CREDENTIALS, fake.fetch).write(REF, new Secret("new-value-1234")),
    ).rejects.toThrow("Infisical holds the change for approval");
  });

  test("a secret that references others is refused, and nothing is written", async () => {
    const fake = fakeInfisical({
      secrets: {
        "prod:/:STRIPE_KEY": { ...STRIPE, value: "${BASE}-${dev.payments.KEY}" },
        "prod:/:BASE": { value: "base" },
      },
    });
    const vault = infisicalBackend(CREDENTIALS, fake.fetch);
    const refused =
      "the secret references infisical://billing/prod/BASE and infisical://billing/dev/payments/KEY, so a new key saved here would leave that secret, and everything that uses it, with the old key; point keypin.toml at the source secret instead";
    await expect(vault.checkWrite?.(REF)).rejects.toThrow(refused);
    await expect(vault.write(REF, new Secret("new-value-1234"))).rejects.toThrow(refused);
    expect(
      fake.calls.filter((c) => c.path.endsWith("/STRIPE_KEY")).map((c) => c.query),
    ).toMatchObject([
      { expandSecretReferences: "false", includeImports: "false" },
      { expandSecretReferences: "false", includeImports: "false" },
    ]);
    expect(fake.calls.some((c) => c.method !== "GET" && c.path.startsWith("/api/v4"))).toBe(false);
    expect(fake.effects).toEqual([]);
  });

  test("a bad rotated day is refused before any request", async () => {
    const fake = fakeInfisical();
    await expect(
      infisicalBackend(CREDENTIALS, fake.fetch).write(REF, new Secret("v"), {
        rotated: "2026-02-30",
      }),
    ).rejects.toThrow(`rotated must be a real day as YYYY-MM-DD, got "2026-02-30"`);
    expect(fake.calls).toEqual([]);
  });
});

test("list names the secrets of a project, environment and path, without values", async () => {
  const fake = fakeInfisical({
    secrets: {
      "prod:/:STRIPE_KEY": STRIPE,
      "dev:/:STRIPE_KEY": { ...STRIPE, id: "secret-dev" },
      "prod:/payments:RESEND_KEY": { ...STRIPE, id: "secret-folder" },
    },
  });
  const items = await infisicalBackend(CREDENTIALS, fake.fetch).list({
    kind: "infisical",
    url: URL,
    organization: "acme",
    project: "billing",
    environment: "prod",
    path: "/",
  });
  expect(items).toEqual([
    {
      id: "secret-1",
      title: "STRIPE_KEY",
      tags: ["billing"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  expect(fake.calls.at(-1)?.query).toMatchObject({
    projectId: PROJECT_ID,
    environment: "prod",
    secretPath: "/",
    viewSecretValue: "false",
    includeImports: "false",
  });
});
