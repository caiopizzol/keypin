import { describe, expect, test } from "vite-plus/test";
import type { KeyRef } from "@keypin/core";
import { onePasswordBackend, type SignInMode } from "../../src/onepassword/index";
import { fakeOnePassword, field, item } from "../../src/onepassword/testing";

const ACCOUNT = "acme.1password.com";

const ref = (vault: string, title: string): KeyRef => ({
  kind: "1password",
  account: ACCOUNT,
  vault,
  item: title,
  section: null,
  field: "password",
});

function inVault(vault: string, title: string) {
  return { ...item(title, [field("password", "Concealed", "v")]), vaultId: `vault-${vault}` };
}

function backendWith(
  vaults: NonNullable<Parameters<typeof fakeOnePassword>[1]>,
  items: ReturnType<typeof inVault>[],
  mode: SignInMode = "desktop",
) {
  const fake = fakeOnePassword(items, [{ title: "Private", vaultType: "personal" }, ...vaults]);
  return { backend: onePasswordBackend(async () => fake.client, mode), calls: fake.calls };
}

describe("notes on the vaults keypin looked up", () => {
  test("a vault of type everyone gets one note naming its items, whatever its name", async () => {
    const { backend } = backendWith(
      [{ title: "Company", vaultType: "everyone" }],
      [inVault("Company", "a"), inVault("Company", "b")],
    );
    const refs = [ref("Company", "a"), ref("company", "b")];
    for (const each of refs) await backend.itemIds(each);
    expect(await backend.notes?.(refs)).toEqual([
      "1Password vault \"Company\" (1Password account acme.1password.com) is the account's default Shared vault. A service account can't be granted it, so scheduled rotation can't read op://Company/a/password, op://company/b/password; move them to a vault you create (docs/guides/service-accounts.md)",
    ]);
  });

  test("a vault you created named Shared, and a personal vault, get no note", async () => {
    const { backend } = backendWith(
      [{ title: "Shared", vaultType: "userCreated" }],
      [inVault("Shared", "a")],
    );
    const created = ref("Shared", "a");
    const personal = ref("Private", "missing");
    await backend.itemIds(created);
    await expect(backend.itemIds(personal)).rejects.toThrow("no such item");
    expect(await backend.notes?.([created, personal])).toEqual([]);
  });

  test("uses only the vault list a lookup already read, and nothing with a service account", async () => {
    const vaults = [{ title: "Shared", vaultType: "everyone" as const }];
    const fresh = backendWith(vaults, [inVault("Shared", "a")]);
    expect(await fresh.backend.notes?.([ref("Shared", "a")])).toEqual([]);
    expect(fresh.calls.lists.vaults).toBe(0);

    const token = backendWith(vaults, [inVault("Shared", "a")], "service-account");
    await token.backend.itemIds(ref("Shared", "a"));
    expect(await token.backend.notes?.([ref("Shared", "a")])).toEqual([]);
  });
});
