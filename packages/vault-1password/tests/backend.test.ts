import { inspect } from "node:util";
import { assert, describe, expect, test } from "vite-plus/test";
import type { KeyRef } from "@keypin/core";
import { Secret } from "@keypin/core";
import type { CreateParams, Field, FullItem, SdkClient } from "../src/index";
import { onePasswordBackend } from "../src/index";

const VALUE = "fake-value-7f3a9c";
const ACCOUNT = "my.1password.com";
const ref: KeyRef = {
  kind: "1password",
  account: ACCOUNT,
  vault: "Private",
  item: "demo dev token",
  section: null,
  field: "password",
};
const scope = { kind: "1password" as const, account: ACCOUNT, vault: "Private" };

function field(title: string, fieldType: Field["fieldType"], value: string): Field {
  return { id: title, title, fieldType, value };
}

function item(title: string, fields: Field[], id = `id-${title}`): FullItem {
  return {
    id,
    title,
    category: "Password",
    vaultId: "vault-1",
    fields,
    sections: [],
    notes: "",
    tags: ["app/demo"],
    websites: [],
    version: 1,
    files: [],
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-09T12:00:00Z"),
  };
}

function fake(items: FullItem[] = [], vaults = ["Private", "Shared"]) {
  const calls: { create: CreateParams[]; put: FullItem[]; get: number } = {
    create: [],
    put: [],
    get: 0,
  };
  const client: SdkClient = {
    vaults: {
      list: async () =>
        vaults.map((title, index) => ({ id: index === 0 ? "vault-1" : `vault-${title}`, title })),
    },
    items: {
      list: async (vaultId) =>
        items
          .filter((candidate) => candidate.vaultId === vaultId)
          .map((candidate) => ({ ...candidate, state: "active", password: VALUE })),
      get: async (_vaultId, itemId) => {
        calls.get += 1;
        const found = items.find((candidate) => candidate.id === itemId);
        if (!found) throw new Error("not found");
        return found;
      },
      create: async (params) => {
        calls.create.push(params);
        return item(params.title, params.fields ?? []);
      },
      put: async (updated) => {
        calls.put.push(updated);
        return updated;
      },
    },
  };
  return { client, calls };
}

function backendFor(client: SdkClient) {
  const accounts: string[] = [];
  const backend = onePasswordBackend(async (account) => {
    accounts.push(account);
    if (account !== ACCOUNT) throw new Error(`no signed-in account named ${account}`);
    return client;
  });
  return { backend, accounts };
}

describe("list", () => {
  test("returns id, title, tags and updatedAt only, even when the SDK's items carry a value", async () => {
    const { client } = fake([item("demo dev token", [field("password", "Concealed", VALUE)])]);
    const { backend } = backendFor(client);
    const items = await backend.list(scope);
    expect(items).toEqual([
      {
        id: "id-demo dev token",
        title: "demo dev token",
        tags: ["app/demo"],
        updatedAt: "2026-11-09T12:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(items)).not.toContain(VALUE);
  });

  test("signs in once per account", async () => {
    const { client } = fake();
    const { backend, accounts } = backendFor(client);
    await backend.list(scope);
    await backend.list(scope);
    expect(accounts).toEqual([ACCOUNT]);
  });
});

describe("read", () => {
  test("returns a Secret that prints as [secret]", async () => {
    const { client } = fake([item("demo dev token", [field("password", "Concealed", VALUE)])]);
    const secret = await backendFor(client).backend.read(ref);
    expect(secret).toBeInstanceOf(Secret);
    expect(secret.reveal()).toBe(VALUE);
    expect(String(secret)).toBe("[secret]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret]"}');
    expect(inspect(secret)).toBe("[secret]");
  });

  test("fails clearly when the item has no such field", async () => {
    const { client } = fake([item("demo dev token", [field("rotated", "Date", "2026-11-09")])]);
    await expect(backendFor(client).backend.read(ref)).rejects.toThrow(
      'op://Private/demo dev token/password (1Password account my.1password.com): the item has no field "password"',
    );
  });

  test("reads the field the reference names, by title in any case, or by ID", async () => {
    const { client } = fake([
      item("demo dev token", [
        field("password", "Concealed", "not-this"),
        { id: "abc123", title: "Credential", fieldType: "Concealed", value: VALUE },
      ]),
    ]);
    const { backend } = backendFor(client);
    expect((await backend.read({ ...ref, field: "credential" })).reveal()).toBe(VALUE);
    expect((await backend.read({ ...ref, field: "abc123" })).reveal()).toBe(VALUE);
  });

  test("a section picks between fields with the same name", async () => {
    const sections = [
      { id: "s-live", title: "live" },
      { id: "s-test", title: "test" },
    ];
    const both = [
      {
        id: "f1",
        title: "key",
        sectionId: "s-test",
        fieldType: "Concealed" as const,
        value: "test-value",
      },
      {
        id: "f2",
        title: "key",
        sectionId: "s-live",
        fieldType: "Concealed" as const,
        value: VALUE,
      },
    ];
    const { client } = fake([{ ...item("demo dev token", both), sections }]);
    const { backend } = backendFor(client);
    expect((await backend.read({ ...ref, section: "live", field: "key" })).reveal()).toBe(VALUE);
    await expect(backend.read({ ...ref, field: "key" })).rejects.toThrow(
      '2 fields are named "key"; name a section',
    );
    await expect(backend.read({ ...ref, section: "staging", field: "key" })).rejects.toThrow(
      'the item has no section "staging"',
    );
  });
});

describe("names in a reference", () => {
  test("find the vault and item by title in any case, or by ID", async () => {
    const { client } = fake([item("Demo Dev Token", [field("password", "Concealed", VALUE)])]);
    const { backend } = backendFor(client);
    for (const named of [
      { vault: "private", item: "demo dev token" },
      { vault: "vault-1", item: "id-Demo Dev Token" },
    ]) {
      expect((await backend.read({ ...ref, ...named })).reveal()).toBe(VALUE);
    }
  });

  test("a name that is one item's ID and another's title is refused, in any case", async () => {
    const { client } = fake([
      item("demo dev token", [field("password", "Concealed", VALUE)], "abc"),
      item("ABC", [field("password", "Concealed", "not-this")], "xyz"),
    ]);
    const { backend } = backendFor(client);
    for (const name of ["abc", "Abc"]) {
      await expect(backend.read({ ...ref, item: name })).rejects.toThrow("2 items have this name");
    }
  });

  test("a field name that is one field's ID and another's title is refused, in any case", async () => {
    const { client } = fake([
      item("demo dev token", [
        { id: "password", title: "old password", fieldType: "Concealed", value: "fake-old" },
        { id: "custom-field", title: "Password", fieldType: "Concealed", value: VALUE },
      ]),
    ]);
    const { backend } = backendFor(client);
    for (const name of ["password", "Password"]) {
      await expect(backend.read({ ...ref, field: name })).rejects.toThrow(
        `2 fields are named "${name}"`,
      );
    }
    expect((await backend.read({ ...ref, field: "CUSTOM-FIELD" })).reveal()).toBe(VALUE);
  });

  test("refuses the rotated field, which keypin writes the rotation day into", async () => {
    const existing = item("demo dev token", [field("rotated", "Date", "2026-11-09")]);
    const { client, calls } = fake([existing]);
    const { backend } = backendFor(client);
    await expect(
      backend.write({ ...ref, field: "rotated" }, new Secret(VALUE), { rotated: "2026-11-10" }),
    ).rejects.toThrow('"rotated" holds the day the value last changed');
    await expect(backend.read({ ...ref, field: "Rotated" })).rejects.toThrow(
      '"rotated" holds the day the value last changed',
    );
    expect(calls.put).toEqual([]);
  });
});

describe("write", () => {
  test("writes the field the reference names, and won't create an item for another field", async () => {
    const existing = item("demo dev token", [
      field("password", "Concealed", "keep-this"),
      field("credential", "Concealed", "old-value"),
    ]);
    const { client, calls } = fake([existing]);
    const { backend } = backendFor(client);
    await backend.write({ ...ref, field: "credential" }, new Secret(VALUE));
    expect(calls.put[0]?.fields).toEqual([
      field("password", "Concealed", "keep-this"),
      field("credential", "Concealed", VALUE),
    ]);
    await expect(
      backend.write({ ...ref, item: "new item", field: "credential" }, new Secret(VALUE)),
    ).rejects.toThrow("no such item; create it in 1Password first");
    expect(calls.create).toEqual([]);
  });

  test("creates a Password item when it is missing, with rotated when asked", async () => {
    const { client, calls } = fake();
    await backendFor(client).backend.write(ref, new Secret(VALUE), { rotated: "2026-11-09" });
    expect(calls.put).toEqual([]);
    expect(calls.create).toHaveLength(1);
    const [created] = calls.create;
    assert(created);
    expect(created).toMatchObject({
      category: "Password",
      vaultId: "vault-1",
      title: "demo dev token",
    });
    expect(created.fields).toEqual([
      { id: "password", title: "password", fieldType: "Concealed", value: VALUE },
      { id: "rotated", title: "rotated", fieldType: "Date", value: "2026-11-09" },
    ]);
  });

  test("updates the password field when the item exists and leaves other fields alone", async () => {
    const existing = item("demo dev token", [
      field("password", "Concealed", "old-value"),
      field("rotate_every", "Text", "180d"),
      field("rotated", "Date", "2026-01-01"),
    ]);
    const { client, calls } = fake([existing]);
    await backendFor(client).backend.write(ref, new Secret(VALUE), { rotated: "2026-11-09" });
    expect(calls.create).toEqual([]);
    expect(calls.put).toHaveLength(1);
    const [put] = calls.put;
    assert(put);
    expect(put.id).toBe(existing.id);
    expect(put.fields).toEqual([
      field("password", "Concealed", VALUE),
      field("rotate_every", "Text", "180d"),
      field("rotated", "Date", "2026-11-09"),
    ]);
  });

  test("leaves rotated unchanged when not asked", async () => {
    const { client, calls } = fake([
      item("demo dev token", [
        field("password", "Concealed", "old-value"),
        field("rotated", "Date", "2026-01-01"),
      ]),
    ]);
    await backendFor(client).backend.write(ref, new Secret(VALUE));
    expect(calls.put[0]?.fields).toContainEqual(field("rotated", "Date", "2026-01-01"));
  });

  test.each(["today", "2026-02-30", "2025-02-29", "2026-13-01", "2026-11-00"])(
    "refuses rotated %s, before touching the vault",
    async (rotated) => {
      const { client, calls } = fake();
      const { backend, accounts } = backendFor(client);
      await expect(backend.write(ref, new Secret(VALUE), { rotated })).rejects.toThrow(
        `rotated must be a real day as YYYY-MM-DD, got "${rotated}"`,
      );
      expect(accounts).toEqual([]);
      expect(calls).toEqual({ create: [], put: [], get: 0 });
    },
  );

  test("accepts a leap day", async () => {
    const { client, calls } = fake();
    await backendFor(client).backend.write(ref, new Secret(VALUE), { rotated: "2028-02-29" });
    expect(calls.create[0]?.fields).toContainEqual(field("rotated", "Date", "2028-02-29"));
  });
});

describe("metadata", () => {
  test("reads the rotated date only", async () => {
    const { client } = fake([
      item("demo dev token", [
        field("password", "Concealed", VALUE),
        field("rotated", "Date", "2026-11-09"),
        field("rotate_every", "Text", "365d"),
        field("notes", "Text", "unrelated"),
      ]),
    ]);
    const metadata = await backendFor(client).backend.metadata(ref);
    expect(metadata).toEqual({ rotated: "2026-11-09" });
    expect(JSON.stringify(metadata)).not.toContain(VALUE);
  });

  test("converts a date stored as Unix seconds to that local day", async () => {
    const localMidnight = new Date(2026, 10, 9).getTime() / 1000;
    const { client } = fake([
      item("demo dev token", [field("rotated", "Date", String(localMidnight))]),
    ]);
    expect(await backendFor(client).backend.metadata(ref)).toEqual({ rotated: "2026-11-09" });
  });

  test("gives null for missing fields", async () => {
    const { client } = fake([item("demo dev token", [field("password", "Concealed", VALUE)])]);
    expect(await backendFor(client).backend.metadata(ref)).toEqual({ rotated: null });
  });

  test("refuses a concealed rotation field without returning its value", async () => {
    const { client } = fake([item("demo dev token", [field("rotated", "Concealed", VALUE)])]);
    const failure = backendFor(client).backend.metadata(ref);
    await expect(failure).rejects.toThrow('field "rotated" is Concealed, expected Text or Date');
    await expect(failure).rejects.not.toThrow(VALUE);
  });

  test("refuses a rotated value that isn't a date", async () => {
    const { client } = fake([item("demo dev token", [field("rotated", "Text", "last week")])]);
    await expect(backendFor(client).backend.metadata(ref)).rejects.toThrow(
      '"rotated" isn\'t a date: "last week"',
    );
  });
});

describe("errors", () => {
  test("names the account when sign-in fails", async () => {
    const { client } = fake();
    const { backend } = backendFor(client);
    await expect(backend.list({ ...scope, account: "wrong.1password.com" })).rejects.toThrow(
      '1Password account "wrong.1password.com": sign-in failed: no signed-in account named wrong.1password.com',
    );
  });

  test("names the account and vault when the vault is missing", async () => {
    const { client } = fake([], ["Shared"]);
    await expect(backendFor(client).backend.list(scope)).rejects.toThrow(
      '1Password account "my.1password.com" has no vault "Private"',
    );
  });

  test("names the item when it is missing", async () => {
    const { client } = fake();
    await expect(backendFor(client).backend.metadata(ref)).rejects.toThrow(
      "op://Private/demo dev token/password (1Password account my.1password.com): no such item",
    );
  });

  test("refuses two items with the same name", async () => {
    const { client } = fake([
      item("demo dev token", [], "id-a"),
      item("demo dev token", [], "id-b"),
    ]);
    await expect(backendFor(client).backend.read(ref)).rejects.toThrow("2 items have this name");
  });
});
