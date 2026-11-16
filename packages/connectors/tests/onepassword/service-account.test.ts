import { describe, expect, test } from "vite-plus/test";
import { type KeyRef, Secret, SignInFailed } from "@keypin/core";
import {
  onePasswordBackend,
  pinKind,
  RateLimited,
  type SdkClient,
  serviceAccountConnect,
  signInAddress,
} from "../../src/onepassword/index";

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

function fakeSdk(vaults = ["Deploy"], create = () => {}) {
  const calls: string[] = [];
  const client: SdkClient = {
    vaults: {
      list: async () => {
        calls.push("vaults.list");
        return vaults.map((title) => ({ id: `vault-${title}`, title }));
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
        create();
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

  test("a pinned address in any form is compared by its host, and refused for another account", async () => {
    const other = [
      "https://other.1password.com/",
      "https://other.1password.com/signin",
      "other.1password.com/",
      "OTHER.1password.com",
      " other.1password.com ",
      "other.1password.com:443",
      "other.1password.com /",
      "Other.1password.com Team",
      "ftp://x",
      "x.",
    ];
    for (const account of other) {
      const { backend, calls, opened } = fakeSdk();
      expect(pinKind(account), account).toBe("address");
      await expect(backend.itemIds(ref(account)), account).rejects.toThrow(
        `the service account signs in to acme.1password.com, but keypin.toml pins ${account}`,
      );
      expect(calls).toEqual([]);
      expect(opened).toEqual([]);
    }
    for (const account of [
      "https://acme.1password.com/",
      "acme.1password.com/",
      "HTTPS://Acme.1Password.com/signin",
    ]) {
      const { backend, opened } = fakeSdk();
      await backend.list({ kind: "1password", account, vault: "Deploy" });
      expect(opened, account).toEqual(["the token"]);
    }
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

  test("a map pinning an account name is accepted like an ID, not taken for an address", async () => {
    const { backend, calls } = fakeSdk();
    await backend.list({ kind: "1password", account: "Acme Corp", vault: "Deploy" });
    expect(calls).toEqual(["vaults.list", "items.list"]);
    expect(pinKind("Acme Corp")).toBe("account name");
    expect(pinKind("Acme Inc.")).toBe("account name");
    expect(pinKind("4Q6Z73JHSJESBM36AP3W57YOOU")).toBe("account ID");
    expect(pinKind("acme.1password.com")).toBe("address");
  });

  test("the pinned address matches in any case, and the client and its lists are shared", async () => {
    const { backend, calls, opened } = fakeSdk();
    await backend.list({ kind: "1password", account: "ACME.1password.com", vault: "Deploy" });
    await backend.list({ kind: "1password", account: "acme.1password.com", vault: "Deploy" });
    expect(opened).toEqual(["the token"]);
    expect(calls).toEqual(["vaults.list", "items.list"]);
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

  test("a rate limit while signing in with the token gives the limits, never the token", async () => {
    const backend = onePasswordBackend(
      serviceAccountConnect(TOKEN, async (token) => {
        throw new RateLimited(`Too Many Requests for ${token}`);
      }),
      "service-account",
    );
    const failure = backend.itemIds(ref("acme.1password.com"));
    await expect(failure).rejects.toThrow(
      "1Password's rate limit was reached: Too Many Requests for [the token]. A service account token gets 1,000 reads",
    );
    await expect(failure).rejects.not.toThrow(TOKEN);
    await expect(failure).rejects.not.toBeInstanceOf(SignInFailed);
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

  test("writes when the service account may: it creates the item", async () => {
    const { backend, calls } = fakeSdk();
    await backend.write(ref("acme.1password.com"), new Secret("value-1234"), { newItem: true });
    expect(calls).toEqual(["vaults.list", "items.list", "items.create"]);
  });

  test("a write the service account isn't allowed says to create one with write access", async () => {
    const { backend } = fakeSdk(["Deploy"], () => {
      throw new Error(
        "An error occurred when processing SDK request: Error { msg: you do not have the right permissions to perform this action: , inner: None }",
      );
    });
    await expect(
      backend.write(ref("acme.1password.com"), new Secret("value-1234"), { newItem: true }),
    ).rejects.toThrow(
      `the service account can't write to the vault "Deploy". Grant write access to it: 1Password can't change a service account's access, so create a new service account with read and write access to that vault, and use its token`,
    );
  });

  test("a built-in vault says service accounts can't open it, and how to move the item", async () => {
    const { backend } = fakeSdk();
    for (const vault of ["Private", "personal", "Employee"])
      await expect(backend.itemIds(ref("acme.1password.com", vault))).rejects.toThrow(
        `service accounts can't open the built-in vault "${vault}"; move the item to a vault you create, update its reference in keypin.toml, and grant the service account read access to that vault`,
      );
  });

  test("a missing Shared vault may be the default one, which service accounts can't open", async () => {
    const { backend } = fakeSdk();
    await expect(backend.itemIds(ref("acme.1password.com", "Shared"))).rejects.toThrow(
      `the vault "Shared" isn't visible to this service account. If it's the default Shared vault, service accounts can't open it; move the item to a vault you create, update its reference in keypin.toml, and grant the service account read access to that vault. If you created it, the service account wasn't granted it`,
    );
  });

  test("a granted vault you named Shared opens like any other", async () => {
    const { backend, calls } = fakeSdk(["Shared"]);
    await expect(
      backend.list({ kind: "1password", account: "acme.1password.com", vault: "Shared" }),
    ).resolves.toEqual([]);
    expect(calls).toEqual(["vaults.list", "items.list"]);
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
