import type { CreateParams, Field, FullItem, SdkClient } from "./sdk";

export function field(title: string, fieldType: Field["fieldType"], value: string): Field {
  return { id: title, title, fieldType, value };
}

export function item(title: string, fields: Field[], id = `id-${title}`): FullItem {
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

export function fakeOnePassword(items: FullItem[] = [], vaults = ["Private", "Shared"]) {
  const calls: { create: CreateParams[]; put: FullItem[]; get: number } = {
    create: [],
    put: [],
    get: 0,
  };
  const effects: string[] = [];
  const held = [...items];
  const client: SdkClient = {
    vaults: {
      list: async () =>
        vaults.map((title, index) => ({ id: index === 0 ? "vault-1" : `vault-${title}`, title })),
    },
    items: {
      list: async (vaultId) =>
        held
          .filter((candidate) => candidate.vaultId === vaultId)
          .map((candidate) => ({
            ...candidate,
            state: "active",
            password: candidate.fields.find((each) => each.title === "password")?.value ?? "",
          })),
      get: async (_vaultId, itemId) => {
        calls.get += 1;
        const found = held.find((candidate) => candidate.id === itemId);
        if (!found) throw new Error("not found");
        return found;
      },
      create: async (params) => {
        calls.create.push(params);
        const created = { ...item(params.title, params.fields ?? []), vaultId: params.vaultId };
        held.push(created);
        effects.push(`1password create ${params.vaultId}/${params.title}`);
        return created;
      },
      put: async (updated) => {
        calls.put.push(updated);
        const at = held.findIndex((candidate) => candidate.id === updated.id);
        if (at === -1) throw new Error("not found");
        held[at] = updated;
        effects.push(`1password update ${updated.vaultId}/${updated.title}`);
        return updated;
      },
    },
  };
  return { client, calls, effects };
}
