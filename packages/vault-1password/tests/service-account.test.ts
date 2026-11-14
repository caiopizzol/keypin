import { describe, expect, test } from "vite-plus/test";
import { type KeyRef, Secret } from "@keypin/core";
import {
  onePasswordBackend,
  type SdkClient,
  serviceAccountConnect,
  signInAddress,
} from "../src/index";

const tokenFor = (fields: Record<string, unknown>) =>
  `ops_${Buffer.from(JSON.stringify(fields)).toString("base64url")}`;
const TOKEN = tokenFor({ signInAddress: "Acme.1Password.com" });

const ref = (account: string, vault = "Deploy"): KeyRef => ({
  kind: "1password",
  account,
  vault,
  item: "demo prod token",
  section: null,
  field: "password",
});

function fakeSdk() {
  const calls: string[] = [];
  const client: SdkClient = {
    vaults: {
      list: async () => {
        calls.push("vaults.list");
        return [{ id: "vault-deploy", title: "Deploy" }];
      },
    },
    items: {
      list: async () => {
        calls.push("items.list");
        return [];
      },
      get: async () => {
        throw new Error("this test gets no item");
      },
      create: async () => {
        calls.push("items.create");
        return {};
      },
      put: async () => {
        calls.push("items.put");
        return {};
      },
    },
  };
  const opened: string[] = [];
  const backend = onePasswordBackend(
    serviceAccountConnect(TOKEN, async (token) => {
      opened.push(token === TOKEN ? "the token" : "another token");
      return client;
    }),
    "service-account",
  );
  return { backend, calls, opened };
}

describe("signInAddress", () => {
  test("reads only signInAddress from the token, in lower case", () => {
    expect(signInAddress(TOKEN)).toBe("acme.1password.com");
  });

  test("a value that isn't a service account token fails without showing it", () => {
    for (const token of ["not-a-token", "ops_%%%", tokenFor({ email: "me@example.com" })]) {
      expect(() => signInAddress(token)).toThrow(
        "OP_SERVICE_ACCOUNT_TOKEN isn't a 1Password service account token",
      );
      try {
        signInAddress(token);
      } catch (error) {
        expect(String(error)).not.toContain(token);
      }
    }
  });
});

describe("a service account sign-in", () => {
  test("a map pinning another account is refused before any vault call, naming both addresses", async () => {
    const { backend, calls, opened } = fakeSdk();
    const failure = backend.itemIds(ref("other.1password.com"));
    await expect(failure).rejects.toThrow(
      "the service account signs in to acme.1password.com, but keypin.toml pins other.1password.com",
    );
    await expect(failure).rejects.not.toThrow(TOKEN);
    expect(calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("a map pinning an account ID is accepted: a token has no ID to check it against", async () => {
    const { backend, calls, opened } = fakeSdk();
    await backend.list({
      kind: "1password",
      account: "4Q6Z73JHSJESBM36AP3W57YOOU",
      vault: "Deploy",
    });
    expect(opened).toEqual(["the token"]);
    expect(calls).toEqual(["vaults.list", "items.list"]);
  });

  test("the pinned address matches in any case, and the client opens once", async () => {
    const { backend, calls, opened } = fakeSdk();
    await backend.list({ kind: "1password", account: "ACME.1password.com", vault: "Deploy" });
    await backend.list({ kind: "1password", account: "acme.1password.com", vault: "Deploy" });
    expect(opened).toEqual(["the token"]);
    expect(calls).toEqual(["vaults.list", "items.list", "vaults.list", "items.list"]);
  });

  test("a sign-in error never shows the token", async () => {
    const backend = onePasswordBackend(
      serviceAccountConnect(TOKEN, async (token) => {
        throw new Error(`invalid token ${token}`);
      }),
      "service-account",
    );
    const failure = backend.itemIds(ref("acme.1password.com"));
    await expect(failure).rejects.toThrow("sign-in failed: invalid token [the token]");
    await expect(failure).rejects.not.toThrow(TOKEN);
  });

  test("a sign-in error is unwrapped from the SDK's Error { msg } text", async () => {
    const backend = onePasswordBackend(
      serviceAccountConnect(TOKEN, async () => {
        throw new Error(
          "An error occurred when processing SDK request: Error { msg: invalid service account token, inner: None }",
        );
      }),
      "service-account",
    );
    const failure = backend.itemIds(ref("acme.1password.com"));
    await expect(failure).rejects.toThrow(
      '1Password account "acme.1password.com": sign-in failed: invalid service account token',
    );
    await expect(failure).rejects.not.toThrow("Error {");
  });

  test("Account not found keeps the SDK's words: the desktop app's hint doesn't apply", async () => {
    const backend = onePasswordBackend(
      serviceAccountConnect(TOKEN, async () => {
        throw new Error("Error { msg: Account not found, inner: None }");
      }),
      "service-account",
    );
    await expect(backend.itemIds(ref("acme.1password.com"))).rejects.toThrow(
      "sign-in failed: Account not found",
    );
  });

  test("only reads: it says it can't write, and a write never reaches 1Password", async () => {
    const { backend, calls } = fakeSdk();
    expect(backend.capabilities.write).toBe(false);
    await expect(
      backend.write(ref("acme.1password.com"), new Secret("value-1234"), { newItem: true }),
    ).rejects.toThrow("writing to 1Password needs the desktop app");
    expect(calls).toEqual([]);
  });

  test("a built-in vault says service accounts can't open it, and how to move the item", async () => {
    const { backend } = fakeSdk();
    for (const vault of ["Private", "personal", "Employee"])
      await expect(backend.itemIds(ref("acme.1password.com", vault))).rejects.toThrow(
        `service accounts can't open the built-in vault "${vault}"; move the item to a vault you create, update its reference in keypin.toml, and grant the service account read access to that vault`,
      );
  });

  test("another missing vault isn't visible to the service account, not a typo", async () => {
    const { backend } = fakeSdk();
    await expect(backend.itemIds(ref("acme.1password.com", "Billing"))).rejects.toThrow(
      `the vault "Billing" isn't visible to this service account (it may not exist, or wasn't granted)`,
    );
  });

  test("with the desktop app, a missing vault reads as before", async () => {
    const backend = onePasswordBackend(async () => emptyClient());
    await expect(backend.itemIds(ref("acme.1password.com", "Private"))).rejects.toThrow(
      `1Password account "acme.1password.com" has no vault "Private"`,
    );
  });
});

function emptyClient(): SdkClient {
  return {
    vaults: { list: async () => [] },
    items: {
      list: async () => [],
      get: async () => {
        throw new Error("no item");
      },
      create: async () => ({}),
      put: async () => ({}),
    },
  };
}
